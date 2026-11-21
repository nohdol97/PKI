<#
  R04 step 2: silent install + size + before-snapshot (R04-R2, R04-C1, R04-C3)
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and never parsed or syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Writes a RAW local result only; pasting requires `python run.py sanitize` first. Windows PowerShell 5.1 syntax.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
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
    $snap['processes'] = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName } | Sort-Object -Unique)
    return $snap
}

$cfg = Get-Config $ConfigPath
$installer = Assert-InstallerConfigured $cfg
$result = New-Result

# Local-only snapshot (lives in the raw folder, never pasted).
Save-RawFile $OutDir 'snapshot-before.json' (Get-Snapshot $cfg)

$size = (Get-Item -LiteralPath $installer).Length
Add-Metric $result 'installer_size_bytes' $size 'bytes'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $PSCmdlet.ShouldProcess('the configured installer', 'run it silently (installs software on this machine)')) { exit 0 }
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
Add-Check $result 'R04-C1:install' $verdict @{ exit_code = [int]$proc.ExitCode; product_exe_present = $exeOk; elevated_shell = $isAdmin }
Save-RawFile $OutDir 'snapshot-after-install.json' (Get-Snapshot $cfg)
Save-Result $result $OutDir
if ($verdict -ne 'PASS') { exit 1 }
