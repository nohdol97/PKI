<#
  R04 step 3: start-up time, N runs (R04-R3, R04-C3). Numbers only; no pass line (R05 sets it).
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and never parsed or syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Writes a RAW local result only; pasting requires `python run.py sanitize` first. Windows PowerShell 5.1 syntax.
#>
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [string]$OutDir = (Join-Path $PSScriptRoot '..\r04-result')
)
. (Join-Path $PSScriptRoot 'common.ps1')

$cfg = Get-Config $ConfigPath
$null = Assert-InstallerConfigured $cfg
$result = New-Result
$installDir = Get-InstallDirPath $cfg
$exe = Join-Path $installDir $cfg.ProductExe
if (-not (Test-Path -LiteralPath $exe)) { Write-FollowUpNotice 'R04-S1' 'product is not installed; run 02-install-silent.ps1 first' }
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)

$apiTimes = @(); $windowTimes = @(); $failed = 0
for ($i = 1; $i -le [int]$cfg.StartupRuns; $i++) {
    Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames
    Start-Sleep -Seconds 2
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $exe -PassThru
    $r = Test-ReadyProbe $p $cfg.Ready $watch
    if ($null -ne $r.api) { $apiTimes += [double]$r.api }
    if ($null -ne $r.window) { $windowTimes += [double]$r.window }
    if (($null -eq $r.api) -and ($null -eq $r.window)) { $failed++ }
    Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames
}
if ($apiTimes.Count -gt 0) { Add-Metric $result 'startup_api_ms_first_run' $apiTimes[0] 'ms' }
Add-Metric $result 'startup_api_ms_median' (Get-Percentile $apiTimes 50) 'ms'
Add-Metric $result 'startup_api_ms_max' (Get-Percentile $apiTimes 100) 'ms'
Add-Metric $result 'startup_window_ms_median' (Get-Percentile $windowTimes 50) 'ms'
$verdict = if ($failed -eq 0) { 'PASS' } else { 'FAIL' }
Add-Check $result 'R04-C3:startup' $verdict @{ runs = [int]$cfg.StartupRuns; runs_without_ready_signal = $failed; ready_timeout_s = [int]$cfg.Ready.TimeoutSeconds } @('tdd_note')
Save-Result $result $OutDir
