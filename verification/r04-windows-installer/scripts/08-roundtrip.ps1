<#
  R04 step 8: synthetic backend round trip over the Local API (R04-R8, R04-C1). Browser/Electron screens are manual.
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and not syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Run on the deployment site's Windows 11 machine with synthetic data only. Windows PowerShell 5.1 syntax.
#>
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [string]$OutDir = (Join-Path $PSScriptRoot '..\r04-result'),
    [switch]$AssumeRunning
)
. (Join-Path $PSScriptRoot 'common.ps1')

$cfg = Get-Config $ConfigPath
$null = Assert-InstallerConfigured $cfg
$result = New-Result
$exe = Join-Path (Get-InstallDirPath $cfg) $cfg.ProductExe
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)
$started = $false
if (-not $AssumeRunning) {
    if (-not (Test-Path -LiteralPath $exe)) { Write-FollowUpNotice 'R04-S1' 'product is not installed; run 02-install-silent.ps1 first' }
    Stop-ProductProcesses $procName $cfg.WorkerProcessNames
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $exe -PassThru
    $null = Test-ReadyProbe $p $cfg.Ready $watch
    $started = $true
}
$rt = $cfg.RoundTrip
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$ok = $false; $status = 0; $length = 0; $contains = $false; $err = ''
try {
    $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $rt.Url -Method $rt.Method -Body $rt.Body -ContentType 'application/json'
    $status = [int]$resp.StatusCode
    $length = $resp.Content.Length
    $contains = $resp.Content.Contains([string]$rt.ExpectContains)
    $ok = ($status -ge 200) -and ($status -lt 300) -and $contains
} catch {
    $err = $_.Exception.GetType().Name
}
$timer.Stop()
if ($started) { Stop-ProductProcesses $procName $cfg.WorkerProcessNames }
Add-Check $result 'R04-C1:roundtrip-api' 'synthetic backend round trip over the Local API' $(if ($ok) { 'PASS' } else { 'FAIL' }) ("HTTP {0}; {1} bytes; expected text present: {2}; {3} ms; error: {4}" -f $status, $length, $contains, $timer.ElapsedMilliseconds, $err) 'This proves the Local API only. The same round trip from the browser UI and from the Electron window is a manual checklist item (CHECKLIST_MANUAL.md).'
Save-Result $result $OutDir
if (-not $ok) { exit 1 }
