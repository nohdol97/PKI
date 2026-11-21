<#
  R04 step 5: single instance, graceful stop, worker lifecycle (R04-R5, R04-C1, R04-C2)
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and never parsed or syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Writes a RAW local result only; pasting requires `python run.py sanitize` first. Windows PowerShell 5.1 syntax.
#>
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [string]$OutDir = (Join-Path $PSScriptRoot '..\r04-result'),
    [switch]$IncludeCrashTest
)
. (Join-Path $PSScriptRoot 'common.ps1')

$cfg = Get-Config $ConfigPath
$null = Assert-InstallerConfigured $cfg
$result = New-Result
$installDir = Get-InstallDirPath $cfg
$exe = Join-Path $installDir $cfg.ProductExe
if (-not (Test-Path -LiteralPath $exe)) { Write-FollowUpNotice 'R04-S1' 'product is not installed; run 02-install-silent.ps1 first' }
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)
$workers = @($cfg.WorkerProcessNames)

function Get-RootInstanceCount {
    # Processes of the product image (under the install folder) whose parent is NOT also a product-image process.
    $mine = @(Get-ProductProcesses $installDir @($procName))
    $ids = @($mine | ForEach-Object { $_.Id })
    $rows = Get-ProcessRows
    $roots = 0
    foreach ($m in $mine) {
        $row = $rows | Where-Object { $_.ProcessId -eq $m.Id } | Select-Object -First 1
        if ($null -ne $row -and $ids -notcontains $row.ParentProcessId) { $roots++ }
    }
    return $roots
}

Stop-ProductProcesses $installDir $procName $workers
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$a = Start-Process -FilePath $exe -PassThru
$null = Test-ReadyProbe $a $cfg.Ready $watch

# --- single instance -------------------------------------------------------------------------------
$b = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 5
$roots = Get-RootInstanceCount
$secondExited = $b.HasExited
$verdict = if (($roots -eq 1) -and $secondExited) { 'PASS' } else { 'FAIL' }
Add-Check $result 'R04-C1:single-instance' $verdict @{ root_instances = $roots; second_launch_exited = $secondExited }

# --- graceful stop ---------------------------------------------------------------------------------
$a.Refresh()
$stopWatch = [System.Diagnostics.Stopwatch]::StartNew()
[void]$a.CloseMainWindow()
$exited = $a.WaitForExit([int]$cfg.GracefulStopWaitSeconds * 1000)
$stopWatch.Stop()
Start-Sleep -Seconds 2
$remaining = @(Get-ProductProcesses $installDir (@($procName) + $workers)).Count
$gv = if ($exited -and ($remaining -eq 0)) { 'PASS' } elseif ($exited) { 'FAIL' } else { 'INCONCLUSIVE' }
Add-Check $result 'R04-C1:graceful-stop' $gv @{ exited = $exited; exit_ms = [int]$stopWatch.ElapsedMilliseconds; processes_still_running = $remaining }
Stop-ProductProcesses $installDir $procName $workers

# --- worker lifecycle after a hard kill of the main process only (R04-C2) --------------------------
if ($IncludeCrashTest) {
    $watch2 = [System.Diagnostics.Stopwatch]::StartNew()
    $c = Start-Process -FilePath $exe -PassThru
    $null = Test-ReadyProbe $c $cfg.Ready $watch2
    Stop-Process -Id $c.Id -Force
    Start-Sleep -Seconds 5
    $orphans = @(Get-ProductProcesses $installDir $workers).Count
    $cv = if ($workers.Count -eq 0) { 'NOT_APPLICABLE' } elseif ($orphans -eq 0) { 'PASS' } else { 'FAIL' }
    Add-Check $result 'R04-C2:worker-orphans' $cv @{ worker_names_configured = $workers.Count; orphans_after_5s = $orphans }
    Stop-ProductProcesses $installDir $procName $workers
}
Save-Result $result $OutDir
