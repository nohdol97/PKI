<#
  R04 step 3: start-up time, N runs (R04-R3, R04-C3). Numbers only; no pass line (R05 sets it).
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
$exe = Join-Path (Get-InstallDirPath $cfg) $cfg.ProductExe
if (-not (Test-Path -LiteralPath $exe)) { Write-FollowUpNotice 'R04-S1' 'product is not installed; run 02-install-silent.ps1 first' }
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)

$apiTimes = @(); $windowTimes = @(); $failed = 0
for ($i = 1; $i -le [int]$cfg.StartupRuns; $i++) {
    Stop-ProductProcesses $procName $cfg.WorkerProcessNames
    Start-Sleep -Seconds 2
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $exe -PassThru
    $r = Test-ReadyProbe $p $cfg.Ready $watch
    if ($null -ne $r.api) { $apiTimes += [double]$r.api }
    if ($null -ne $r.window) { $windowTimes += [double]$r.window }
    if (($null -eq $r.api) -and ($null -eq $r.window)) { $failed++ }
    Stop-ProductProcesses $procName $cfg.WorkerProcessNames
}
Add-Metric $result 'startup_api_ms_first_run' ($(if ($apiTimes.Count -gt 0) { $apiTimes[0] } else { $null })) 'ms'
Add-Metric $result 'startup_api_ms_median' (Get-Percentile $apiTimes 50) 'ms'
Add-Metric $result 'startup_api_ms_max' (Get-Percentile $apiTimes 100) 'ms'
Add-Metric $result 'startup_window_ms_median' (Get-Percentile $windowTimes 50) 'ms'
Add-Metric $result 'startup_runs_without_ready_signal' $failed 'runs'
$verdict = if ($failed -eq 0) { 'PASS' } else { 'FAIL' }
Add-Check $result 'R04-C3:startup' 'start-up time to the ready signal (numbers only)' $verdict ("{0} runs; {1} without a ready signal within {2}s" -f $cfg.StartupRuns, $failed, $cfg.Ready.TimeoutSeconds) 'The first run after a reboot is the cold start; this script cannot reboot. Record that run separately by hand.'
Save-Result $result $OutDir
