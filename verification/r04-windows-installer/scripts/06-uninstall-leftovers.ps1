<#
  R04 step 6: silent uninstall and leftover check (R04-R6, R04-C1). Reports only DIFFERENCES.
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and not syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Run on the deployment site's Windows 11 machine with synthetic data only. Windows PowerShell 5.1 syntax.
#>
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [string]$OutDir = (Join-Path $PSScriptRoot '..\r04-result')
)
. (Join-Path $PSScriptRoot 'common.ps1')

$cfg = Get-Config $ConfigPath
$null = Assert-InstallerConfigured $cfg
$result = New-Result
$before = Join-Path $OutDir 'snapshot-before.json'
if (-not (Test-Path -LiteralPath $before)) { Write-FollowUpNotice 'R04-S1' 'snapshot-before.json is missing; 02-install-silent.ps1 creates it before installing' }
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)
Stop-ProductProcesses $procName $cfg.WorkerProcessNames

$installDir = Get-InstallDirPath $cfg
$uninstaller = Join-Path $installDir $cfg.UninstallerRelativePath
if (-not (Test-Path -LiteralPath $uninstaller)) {
    Add-Check $result 'R04-C1:uninstall' 'silent uninstall' 'FAIL' 'uninstaller not found at the configured relative path'
    Save-Result $result $OutDir
    exit 1
}
$proc = Start-Process -FilePath $uninstaller -ArgumentList $cfg.SilentUninstallArgs -PassThru -Wait
# Some uninstallers copy themselves to a temp folder and return at once: wait for the install folder to disappear.
$deadline = (Get-Date).AddSeconds(90)
while ((Test-Path -LiteralPath $installDir) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 2 }

# Re-create the snapshot with the same logic as 02 (dot-source its function by re-declaring the small helper set).
$watchFolders = @($cfg.WatchFolders)
$added = @(); $removed = @()
$old = Get-Content -Raw -LiteralPath $before | ConvertFrom-Json
foreach ($w in $watchFolders) {
    $key = "dir:$w"
    $oldNames = @($old.$key)
    $newNames = @(Get-ChildItem -LiteralPath (Resolve-PathValue $w) -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $added += @($newNames | Where-Object { $oldNames -notcontains $_ } | ForEach-Object { "$w\$_" })
    $removed += @($oldNames | Where-Object { $newNames -notcontains $_ } | ForEach-Object { "$w\$_" })
}
$tasksNow = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
$servicesNow = @(Get-Service -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$addedTasks = @($tasksNow | Where-Object { @($old.tasks) -notcontains $_ })
$addedServices = @($servicesNow | Where-Object { @($old.services) -notcontains $_ })
$runNow = @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' |
    ForEach-Object { (Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue).PSObject.Properties } | ForEach-Object { $_.Name })
$addedRun = @($runNow | Where-Object { @($old.run) -notcontains $_ })

$leftFiles = @()
if (Test-Path -LiteralPath $installDir) {
    $leftFiles = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 50 | ForEach-Object { $_.FullName.Substring($installDir.Length) })
}
$product = [string]$cfg.ProductName
$userData = @($added | Where-Object { $_ -like "*$product*" -and ($_ -like '*APPDATA*') })
$otherAdded = @($added | Where-Object { $userData -notcontains $_ })
$hard = $leftFiles.Count + $addedTasks.Count + $addedServices.Count + $addedRun.Count + $otherAdded.Count
$verdict = if (($proc.ExitCode -eq 0) -and ($hard -eq 0) -and ($userData.Count -eq 0)) { 'PASS' } elseif (($proc.ExitCode -eq 0) -and ($hard -eq 0)) { 'INCONCLUSIVE' } else { 'FAIL' }
Add-Check $result 'R04-C1:uninstall' 'silent uninstall leaves nothing behind' $verdict ("uninstaller exit {0}; install folder files left: {1}; new tasks: {2}; new services: {3}; new Run entries: {4}; other new entries: {5}; user-data folders left: {6}" -f $proc.ExitCode, $leftFiles.Count, $addedTasks.Count, $addedServices.Count, $addedRun.Count, $otherAdded.Count, $userData.Count) 'INCONCLUSIVE means only a user-data folder remains: decide whether keeping user data on uninstall is intended.' @{ left_files = $leftFiles; added = $otherAdded; user_data = $userData; removed = $removed }
Save-Result $result $OutDir
if ($verdict -eq 'FAIL') { exit 1 }
