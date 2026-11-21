<#
  R04 step 2: silent install + size + before/after snapshots (R04-R2, R04-C1, R04-C3)
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and not syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Run on the deployment site's Windows 11 machine with synthetic data only. Windows PowerShell 5.1 syntax.
#>
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [string]$OutDir = (Join-Path $PSScriptRoot '..\r04-result')
)
. (Join-Path $PSScriptRoot 'common.ps1')

function Get-Snapshot {
    param($Config)
    $snap = [ordered]@{}
    foreach ($w in $Config.WatchFolders) {
        $p = Resolve-PathValue $w
        $snap["dir:$w"] = @(Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    }
    $snap['uninstall'] = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' |
        ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.PSChildName })
    $snap['run'] = @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' |
        ForEach-Object { (Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue).PSObject.Properties } | ForEach-Object { $_.Name })
    $snap['startmenu'] = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs') |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.Name })
    $snap['tasks'] = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
    $snap['services'] = @(Get-Service -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    return $snap
}

$cfg = Get-Config $ConfigPath
$installer = Assert-InstallerConfigured $cfg
$result = New-Result
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Local-only snapshot (kept next to the result, never pasted into an issue).
ConvertTo-Json -InputObject (Get-Snapshot $cfg) -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir 'snapshot-before.json') -Encoding UTF8

$size = (Get-Item -LiteralPath $installer).Length
Add-Metric $result 'installer_size_bytes' $size 'bytes'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $installer -ArgumentList $cfg.SilentInstallArgs -PassThru -Wait
$watch.Stop()

$installDir = Get-InstallDirPath $cfg
$exe = Join-Path $installDir $cfg.ProductExe
$exeOk = Test-Path -LiteralPath $exe
$sz = Get-DirSizeBytes $installDir
Add-Metric $result 'install_duration_ms' $watch.ElapsedMilliseconds 'ms'
Add-Metric $result 'installed_size_bytes' $sz.bytes 'bytes'
Add-Metric $result 'installed_file_count' $sz.files 'files'
$verdict = if (($proc.ExitCode -eq 0) -and $exeOk) { 'PASS' } else { 'FAIL' }
Add-Check $result 'R04-C1:install' 'silent install without separately installed runtimes' $verdict ("exit code {0}; product exe present: {1}; elevated shell: {2}" -f $proc.ExitCode, $exeOk, $isAdmin) 'Run 01-preflight first; a UAC prompt or a visible wizard is a finding to note by hand.'
ConvertTo-Json -InputObject (Get-Snapshot $cfg) -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir 'snapshot-after-install.json') -Encoding UTF8
Save-Result $result $OutDir
if ($verdict -ne 'PASS') { exit 1 }
