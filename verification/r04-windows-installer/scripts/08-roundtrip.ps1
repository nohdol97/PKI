<#
  R04 step 8: synthetic backend round trip over the Local API (R04-R8, R04-C1). Browser/Electron screens are manual.
  STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and never parsed or syntax-checked (no PowerShell where it was written).
  Needs a V01 skeleton installer artifact; without one it prints the follow-up notice (R04-S1) and exits 3.
  Writes a RAW local result only; pasting requires `python run.py sanitize` first. Windows PowerShell 5.1 syntax.
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
$installDir = Get-InstallDirPath $cfg
$exe = Join-Path $installDir $cfg.ProductExe
$procName = [IO.Path]::GetFileNameWithoutExtension($cfg.ProductExe)
$rt = $cfg.RoundTrip
Assert-Loopback ([string]$rt.Url)
$started = $false
if (-not $AssumeRunning) {
    if (-not (Test-Path -LiteralPath $exe)) { Write-FollowUpNotice 'R04-S1' 'product is not installed; run 02-install-silent.ps1 first' }
    Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $exe -PassThru
    $null = Test-ReadyProbe $p $cfg.Ready $watch
    $started = $true
}
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$ok = $false; $status = 0; $length = 0; $contains = $false; $hadError = $false
try {
    $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $rt.Url -Method $rt.Method -Body $rt.Body -ContentType 'application/json'
    $status = [int]$resp.StatusCode
    $length = $resp.Content.Length
    $contains = $resp.Content.Contains([string]$rt.ExpectContains)
    $ok = ($status -ge 200) -and ($status -lt 300) -and $contains
} catch {
    $hadError = $true
}
$timer.Stop()
if ($started) { Stop-ProductProcesses $installDir $procName $cfg.WorkerProcessNames }
Add-Check $result 'R04-C1:roundtrip-api' $(if ($ok) { 'PASS' } else { 'FAIL' }) @{ http_status = $status; response_bytes = $length; expected_text_present = $contains; elapsed_ms = [int]$timer.ElapsedMilliseconds; had_error = $hadError }
Save-Result $result $OutDir
if (-not $ok) { exit 1 }
