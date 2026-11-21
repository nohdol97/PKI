<#
  R04 step 4: idle CPU / RSS sampling of the product process tree (R04-R4, R04-C3). Numbers only.
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
$logical = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe -PassThru
$ready = Test-ReadyProbe $p $cfg.Ready $watch
if (($null -eq $ready.api) -and ($null -eq $ready.window)) {
    Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames
    Add-Check $result 'R04-C3:idle' 'INCONCLUSIVE' @{ ready_signal_seen = $false; samples = 0 }
    Save-Result $result $OutDir
    exit 1
}
Start-Sleep -Seconds ([int]$cfg.Idle.WarmupSeconds)

$rss = @(); $cpuPct = @(); $maxProcs = 0
$last = Get-TreeStats $p.Id $cfg.WorkerProcessNames
$lastTime = Get-Date
$samples = [math]::Floor([int]$cfg.Idle.ObserveSeconds / [int]$cfg.Idle.IntervalSeconds)
for ($i = 0; $i -lt $samples; $i++) {
    Start-Sleep -Seconds ([int]$cfg.Idle.IntervalSeconds)
    $now = Get-TreeStats $p.Id $cfg.WorkerProcessNames
    $nowTime = Get-Date
    $wall = ($nowTime - $lastTime).TotalSeconds
    if ($wall -gt 0) { $cpuPct += [math]::Max(0, ($now.cpu_seconds - $last.cpu_seconds) / $wall / $logical * 100.0) }
    $rss += [double]$now.rss_bytes
    $maxProcs = [math]::Max($maxProcs, $now.count)
    $last = $now; $lastTime = $nowTime
}
Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames
if ($rss.Count -gt 0) {
    Add-Metric $result 'idle_rss_mb_median' ([math]::Round((Get-Percentile $rss 50) / 1MB, 1)) 'MB'
    Add-Metric $result 'idle_rss_mb_p95' ([math]::Round((Get-Percentile $rss 95) / 1MB, 1)) 'MB'
    Add-Metric $result 'idle_rss_mb_max' ([math]::Round((Get-Percentile $rss 100) / 1MB, 1)) 'MB'
}
if ($cpuPct.Count -gt 0) {
    Add-Metric $result 'idle_cpu_pct_median' ([math]::Round((Get-Percentile $cpuPct 50), 2)) 'pct'
    Add-Metric $result 'idle_cpu_pct_p95' ([math]::Round((Get-Percentile $cpuPct 95), 2)) 'pct'
}
Add-Metric $result 'idle_process_count_max' $maxProcs 'processes'
$idleVerdict = if ($rss.Count -gt 0) { 'PASS' } else { 'INCONCLUSIVE' }
Add-Check $result 'R04-C3:idle' $idleVerdict @{ samples = [int]$samples; interval_s = [int]$cfg.Idle.IntervalSeconds; warmup_s = [int]$cfg.Idle.WarmupSeconds } @('tdd_note')
Save-Result $result $OutDir
