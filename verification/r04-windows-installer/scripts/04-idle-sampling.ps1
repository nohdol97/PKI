<#
  R04 step 4: idle CPU / RSS sampling of the product process tree (R04-R4, R04-C3). Numbers only.
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
$logical = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

Stop-ProductProcesses $procName $cfg.WorkerProcessNames
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe -PassThru
$ready = Test-ReadyProbe $p $cfg.Ready $watch
if (($null -eq $ready.api) -and ($null -eq $ready.window)) {
    Stop-ProductProcesses $procName $cfg.WorkerProcessNames
    Add-Check $result 'R04-C3:idle' 'idle CPU/RSS of the process tree' 'INCONCLUSIVE' 'the product never reported ready, nothing was sampled'
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
Stop-ProductProcesses $procName $cfg.WorkerProcessNames
Add-Metric $result 'idle_rss_mb_median' ([math]::Round((Get-Percentile $rss 50) / 1MB, 1)) 'MB'
Add-Metric $result 'idle_rss_mb_p95' ([math]::Round((Get-Percentile $rss 95) / 1MB, 1)) 'MB'
Add-Metric $result 'idle_rss_mb_max' ([math]::Round((Get-Percentile $rss 100) / 1MB, 1)) 'MB'
Add-Metric $result 'idle_cpu_pct_median' ([math]::Round((Get-Percentile $cpuPct 50), 2)) '% of all logical CPUs'
Add-Metric $result 'idle_cpu_pct_p95' ([math]::Round((Get-Percentile $cpuPct 95), 2)) '% of all logical CPUs'
Add-Metric $result 'idle_process_count_max' $maxProcs 'processes'
Add-Check $result 'R04-C3:idle' 'idle CPU/RSS of the process tree (numbers only)' 'PASS' ("{0} samples every {1}s after {2}s warm-up" -f $samples, $cfg.Idle.IntervalSeconds, $cfg.Idle.WarmupSeconds) 'RSS here is the working set of every process in the tree (shared pages are counted once per process, so it over-reports). No pass line: R05 sets it.'
Save-Result $result $OutDir
