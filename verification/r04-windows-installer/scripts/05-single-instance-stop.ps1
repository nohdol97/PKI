<#
  R04 step 5: single instance, graceful stop, worker lifecycle (R04-R5, R04-C1, R04-C2)
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and not syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Run on the deployment site's Windows 11 machine with synthetic data only. Windows PowerShell 5.1 syntax.
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
$exe = Join-Path (Get-InstallDirPath $cfg) $cfg.ProductExe
if (-not (Test-Path -LiteralPath $exe)) { Write-FollowUpNotice 'R04-S1' 'product is not installed; run 02-install-silent.ps1 first' }
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)
$workers = @($cfg.WorkerProcessNames)

function Get-RootInstanceCount {
    # Processes of the product image whose parent is NOT also a product-image process (Electron starts many helpers).
    $rows = Get-ProcessRows
    $mine = @($rows | Where-Object { ($_.Name -replace '\.exe$', '') -eq $procName })
    $ids = @($mine | ForEach-Object { $_.ProcessId })
    return @($mine | Where-Object { $ids -notcontains $_.ParentProcessId }).Count
}

Stop-ProductProcesses $procName $workers
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$a = Start-Process -FilePath $exe -PassThru
$null = Test-ReadyProbe $a $cfg.Ready $watch

# --- single instance -------------------------------------------------------------------------------
$b = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 5
$roots = Get-RootInstanceCount
$secondExited = $b.HasExited
$verdict = if (($roots -eq 1) -and $secondExited) { 'PASS' } else { 'FAIL' }
Add-Check $result 'R04-C1:single-instance' 'a second launch does not start a second instance' $verdict ("root instances: {0}; second launch exited: {1}" -f $roots, $secondExited) 'Whether the first window was brought to the front is a manual check (checklist).'

# --- graceful stop ---------------------------------------------------------------------------------
$a.Refresh()
$stopWatch = [System.Diagnostics.Stopwatch]::StartNew()
[void]$a.CloseMainWindow()
$exited = $a.WaitForExit([int]$cfg.GracefulStopWaitSeconds * 1000)
$stopWatch.Stop()
Start-Sleep -Seconds 2
$remaining = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { (@($procName) + $workers) -contains ($_.ProcessName) }).Count
$gv = if ($exited -and ($remaining -eq 0)) { 'PASS' } elseif ($exited) { 'FAIL' } else { 'INCONCLUSIVE' }
Add-Check $result 'R04-C1:graceful-stop' 'a close request ends the product and leaves no worker processes' $gv ("exited: {0} after {1} ms; product/worker processes still running: {2}" -f $exited, $stopWatch.ElapsedMilliseconds, $remaining) 'INCONCLUSIVE usually means the app hides to the tray on close; use its own Quit command by hand and record it.'
Stop-ProductProcesses $procName $workers

# --- worker lifecycle after a hard kill of the main process only (R04-C2) --------------------------
if ($IncludeCrashTest) {
    $watch2 = [System.Diagnostics.Stopwatch]::StartNew()
    $c = Start-Process -FilePath $exe -PassThru
    $null = Test-ReadyProbe $c $cfg.Ready $watch2
    Stop-Process -Id $c.Id -Force
    Start-Sleep -Seconds 5
    $orphans = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $workers -contains $_.ProcessName }).Count
    $cv = if ($workers.Count -eq 0) { 'NOT_APPLICABLE' } elseif ($orphans -eq 0) { 'PASS' } else { 'FAIL' }
    Add-Check $result 'R04-C2:worker-orphans' 'after the main process is killed, no worker process stays behind' $cv ("worker names configured: {0}; orphans after 5 s: {1}" -f $workers.Count, $orphans) 'Only meaningful for the second installer that bundles a Python/native worker (R04-S2).'
    Stop-ProductProcesses $procName $workers
}
Save-Result $result $OutDir
