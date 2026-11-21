<#
  R04 step 6: silent uninstall and leftover check (R04-R6, R04-C1). Counts only; names stay in raw\leftovers.json.
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

$cfg = Get-Config $ConfigPath
$null = Assert-InstallerConfigured $cfg
$result = New-Result
$before = Join-Path (Join-Path $OutDir 'raw') 'snapshot-before.json'
if (-not (Test-Path -LiteralPath $before)) { Write-FollowUpNotice 'R04-S1' 'raw\snapshot-before.json is missing; 02-install-silent.ps1 creates it before installing' }
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)
$installDir = Get-InstallDirPath $cfg
Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames

$uninstaller = Join-Path $installDir $cfg.UninstallerRelativePath
if (-not (Test-Path -LiteralPath $uninstaller)) {
    Add-Check $result 'R04-C1:uninstall' 'FAIL' @{ uninstaller_found = $false }
    Save-Result $result $OutDir
    exit 1
}
if (-not $PSCmdlet.ShouldProcess('the product uninstaller', 'run it silently (removes software from this machine)')) { exit 0 }
$proc = Start-Process -FilePath $uninstaller -ArgumentList $cfg.SilentUninstallArgs -PassThru -Wait
# Some uninstallers copy themselves to a temp folder and return at once: wait for the install folder to disappear.
$deadline = (Get-Date).AddSeconds(90)
while ((Test-Path -LiteralPath $installDir) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 2 }

$old = Get-Content -Raw -LiteralPath $before | ConvertFrom-Json
$product = [string]$cfg.ProductName
$addedNames = @(); $removedNames = @()
foreach ($w in @($cfg.WatchFolders)) {
    $oldNames = @($old."dir:$w")
    $newNames = @(Get-ChildItem -LiteralPath (Resolve-PathValue $w) -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $addedNames += @($newNames | Where-Object { $oldNames -notcontains $_ } | ForEach-Object { "$w\$_" })
    $removedNames += @($oldNames | Where-Object { $newNames -notcontains $_ } | ForEach-Object { "$w\$_" })
}
function Get-Added { param($OldList, $NewList) return @(@($NewList) | Where-Object { @($OldList) -notcontains $_ }) }
$tasksNow = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
$servicesNow = @(Get-Service -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$runNow = @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' |
    ForEach-Object { (Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue).PSObject.Properties } | ForEach-Object { $_.Name })
$uninstallNow = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' | ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.PSChildName })
$startMenuNow = @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs') |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.Name })
$processesNow = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName } | Sort-Object -Unique)

$addedTasks = Get-Added $old.tasks $tasksNow
$addedServices = Get-Added $old.services $servicesNow
$addedRun = Get-Added $old.run $runNow
$addedUninstall = Get-Added $old.uninstall $uninstallNow
$addedStartMenu = Get-Added $old.startmenu $startMenuNow
$addedProcesses = Get-Added $old.processes $processesNow
$productProcessesLeft = @(Get-ProductProcesses $installDir (@($procName) + @($cfg.WorkerProcessNames))).Count

$leftFiles = @()
if (Test-Path -LiteralPath $installDir) {
    $leftFiles = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 50 | ForEach-Object { $_.FullName.Substring($installDir.Length) })
}
$userData = @($addedNames | Where-Object { $_ -like "*$product*" -and $_ -like '*APPDATA*' })
$otherAdded = @($addedNames | Where-Object { $userData -notcontains $_ })
$hard = $leftFiles.Count + $addedTasks.Count + $addedServices.Count + $addedRun.Count + $addedUninstall.Count + $addedStartMenu.Count + $productProcessesLeft + $otherAdded.Count
$verdict = if (($proc.ExitCode -eq 0) -and ($hard -eq 0) -and ($userData.Count -eq 0)) { 'PASS' } elseif (($proc.ExitCode -eq 0) -and ($hard -eq 0)) { 'INCONCLUSIVE' } else { 'FAIL' }
Add-Check $result 'R04-C1:uninstall' $verdict @{
    uninstaller_exit_code = [int]$proc.ExitCode; install_folder_files_left = $leftFiles.Count; new_tasks = $addedTasks.Count; new_services = $addedServices.Count
    new_run_entries = $addedRun.Count; new_uninstall_keys = $addedUninstall.Count; new_startmenu_entries = $addedStartMenu.Count
    product_processes_left = $productProcessesLeft; other_new_folder_entries = $otherAdded.Count; user_data_folders_left = $userData.Count
    new_process_names_vs_before = $addedProcesses.Count
} $(if ($verdict -eq 'INCONCLUSIVE') { @('r04_product_user_data_left') } else { @() })
# Names of anything that appeared or disappeared stay LOCAL (they may be other software on this machine).
Save-RawFile $OutDir 'leftovers.json' @{ left_files = $leftFiles; added = $otherAdded; user_data = $userData; removed = $removedNames; tasks = $addedTasks; services = $addedServices }
Save-Result $result $OutDir
if ($verdict -eq 'FAIL') { exit 1 }
