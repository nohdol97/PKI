<#
  R04 shared functions. STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and not even syntax-checked
  (no PowerShell was available where this was written). Windows PowerShell 5.1 syntax only.
  Dot-source from the numbered scripts:  . (Join-Path $PSScriptRoot 'common.ps1')

  These scripts write a RAW result (raw\result-raw.json) plus local-only raw files under $OutDir\raw. The raw result is
  NOT pasteable. `python run.py sanitize` projects it onto the allowlisted schema (harness-generated values only), which
  is the only thing that may be pasted. Free text, names and paths therefore never reach the pasteable file even if a
  script here is wrong. Facts passed to Add-Check should be booleans, numbers, or words from the fixed vocabulary.
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:KitName = 'r04-windows-installer'
$script:NoticeExit = 3

function Write-FollowUpNotice {
    param([string]$Item, [string]$Text)
    Write-Host ("미구현, 배포처 후속: {0} - {1}" -f $Item, $Text)
    exit $script:NoticeExit
}

function Get-Config {
    param([string]$ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        Write-FollowUpNotice 'R04-S1' "config file not found: copy config.example.json to config.json and fill it in after the V01 skeleton installer exists"
    }
    $cfg = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
    return $cfg
}

function Resolve-PathValue {
    param([string]$Value)
    return [Environment]::ExpandEnvironmentVariables($Value)
}

function Assert-InstallerConfigured {
    param($Config)
    $p = Resolve-PathValue $Config.InstallerPath
    if (($Config.InstallerPath -like '<*') -or -not (Test-Path -LiteralPath $p)) {
        Write-FollowUpNotice 'R04-S1' 'no installer artifact: this kit needs the V01 skeleton installer (set InstallerPath in config.json)'
    }
    return $p
}

# ---- result object -----------------------------------------------------------------------------
function New-Result {
    return [ordered]@{
        schema_version = 1
        kit            = $script:KitName
        mode           = 'real'
        created        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        environment    = (Get-EnvFingerprint)
        checks         = (New-Object System.Collections.ArrayList)
        metrics        = [ordered]@{}
        raw            = [ordered]@{}
        notes          = (New-Object System.Collections.ArrayList)
    }
}

function Add-Check {
    # Facts: booleans, numbers, or short words from the fixed vocabulary (anything else is dropped by sanitize_result.py).
    param($Result, [string]$Id, [string]$Verdict, $Facts = @{}, [string[]]$Codes = @())
    $valid = @('PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_RUN', 'NOT_APPLICABLE')
    if ($valid -notcontains $Verdict) { throw "bad verdict $Verdict" }
    $check = [ordered]@{ id = $Id; verdict = $Verdict; facts = $Facts; codes = @($Codes) }
    [void]$Result.checks.Add($check)
}

function Add-Metric {
    param($Result, [string]$Name, $Value, [string]$Unit = '')
    $Result.metrics[$Name] = [ordered]@{ value = $Value; unit = $Unit }
}

function Add-Note {
    param($Result, [string]$Code)
    [void]$Result.notes.Add($Code)
}

function Get-RawDir {
    param([string]$OutDir)
    $dir = Join-Path $OutDir 'raw'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'README_NEVER_PASTE.txt') -Value 'LOCAL ONLY. Raw output, names and snapshots. Never paste or commit this folder.' -Encoding UTF8
    return $dir
}

function Save-RawFile {
    param([string]$OutDir, [string]$Name, $Object)
    $dir = Get-RawDir $OutDir
    ConvertTo-Json -InputObject $Object -Depth 6 | Set-Content -LiteralPath (Join-Path $dir $Name) -Encoding UTF8
}

function Save-Result {
    # Writes raw\result-raw.json (NOT pasteable). Merges with an earlier raw result of the same kit (same ids replaced).
    param($Result, [string]$OutDir)
    $dir = Get-RawDir $OutDir
    $path = Join-Path $dir 'result-raw.json'
    if (Test-Path -LiteralPath $path) {
        $old = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
        if ($old.kit -eq $script:KitName) {
            $have = @($Result.checks | ForEach-Object { $_.id })
            $merged = New-Object System.Collections.ArrayList
            foreach ($c in @($old.checks | Where-Object { $have -notcontains $_.id })) { [void]$merged.Add($c) }
            foreach ($c in $Result.checks) { [void]$merged.Add($c) }
            $Result.checks = $merged
            foreach ($prop in $old.metrics.PSObject.Properties) {
                if (-not $Result.metrics.Contains($prop.Name)) { $Result.metrics[$prop.Name] = $prop.Value }
            }
        }
    }
    $json = ConvertTo-Json -InputObject $Result -Depth 8
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host 'wrote the RAW result (local only). Next, on any machine with Python: python run.py sanitize --raw <that file> --out <folder>'
}

function Assert-Loopback {
    param([string]$Url)
    if ([string]::IsNullOrEmpty($Url)) { return }
    $u = [Uri]$Url
    if (@('127.0.0.1', 'localhost', '::1', '[::1]') -notcontains $u.Host) { throw "URL must be loopback only: $Url" }
}

# ---- environment fingerprint (nothing identifying) ----------------------------------------------
function Get-CpuClass {
    param([int]$Count)
    foreach ($limit in 2, 4, 8, 16) { if ($Count -le $limit) { return "<=$limit cores" } }
    return '>16 cores'
}

function Get-RamClass {
    param([double]$Bytes)
    $gb = $Bytes / 1GB
    foreach ($limit in 8, 16, 32, 64) { if ($gb -le $limit) { return "<=$limit GB" } }
    return '>64 GB'
}

function Get-EnvFingerprint {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    return [ordered]@{
        os          = 'Windows'
        os_release  = [string]$os.Caption
        os_version  = [string]$os.BuildNumber
        machine     = [string]$os.OSArchitecture
        cpu_class   = (Get-CpuClass ([int]$cs.NumberOfLogicalProcessors))
        ram_class   = (Get-RamClass ([double]$cs.TotalPhysicalMemory))
        powershell  = [string]$PSVersionTable.PSVersion
    }
}

# ---- process helpers ----------------------------------------------------------------------------
function Get-ProcessRows {
    return @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, KernelModeTime, UserModeTime)
}

function Get-DescendantIds {
    param($Rows, [int]$RootPid)
    $found = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($r in $Rows) {
            if ($r.ParentProcessId -eq $current -and $found -notcontains $r.ProcessId) {
                [void]$found.Add($r.ProcessId)
                $queue.Enqueue($r.ProcessId)
            }
        }
    }
    return @($found)
}

function Get-TreeStats {
    # Root + descendants + any extra process names (worker processes that were re-parented).
    param([int]$RootPid, [string[]]$ExtraNames = @())
    $rows = Get-ProcessRows
    $ids = @($RootPid) + (Get-DescendantIds $rows $RootPid)
    foreach ($r in $rows) { if ($ExtraNames -contains ($r.Name -replace '\.exe$', '') -and $ids -notcontains $r.ProcessId) { $ids += $r.ProcessId } }
    $picked = @($rows | Where-Object { $ids -contains $_.ProcessId })
    $rss = 0.0; $cpu = 0.0
    foreach ($p in $picked) { $rss += [double]$p.WorkingSetSize; $cpu += ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 1e7 }
    return [ordered]@{ count = $picked.Count; rss_bytes = $rss; cpu_seconds = $cpu; ids = $ids }
}

function Get-Percentile {
    param([double[]]$Values, [double]$P)
    if ($Values.Count -eq 0) { return $null }
    $sorted = $Values | Sort-Object
    $index = [math]::Min($sorted.Count - 1, [math]::Ceiling($P / 100.0 * $sorted.Count) - 1)
    return $sorted[[math]::Max(0, $index)]
}

function Get-ProductProcesses {
    # Exact names only (wildcards refused), and only processes whose executable lives under the install folder.
    param([string]$InstallDir, [string[]]$Names)
    $found = @()
    foreach ($n in $Names) {
        if ($n -match '[\*\?\[]') { throw "wildcards are not allowed in process names: $n" }
        foreach ($p in @(Get-Process -Name ($n -replace '\.exe$', '') -ErrorAction SilentlyContinue)) {
            $path = $null
            try { $path = $p.Path } catch { }
            if ($path -and $path.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)) { $found += $p }
        }
    }
    return $found
}

function Stop-ProductProcesses {
    param([string]$InstallDir, [string]$ProcessName, [string[]]$ExtraNames = @())
    foreach ($p in (Get-ProductProcesses $InstallDir (@($ProcessName) + $ExtraNames))) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReadyProbe {
    # Returns @{ api = ms or $null; window = ms or $null } polling until timeout.
    param($Process, $Ready, [System.Diagnostics.Stopwatch]$Watch)
    Assert-Loopback ([string]$Ready.Url)
    $result = @{ api = $null; window = $null }
    $timeoutMs = [int]$Ready.TimeoutSeconds * 1000
    while ($Watch.ElapsedMilliseconds -lt $timeoutMs) {
        if ($null -eq $result.window -and $Ready.ProcessWindow) {
            $Process.Refresh()
            if ($Process.MainWindowHandle -ne [IntPtr]::Zero) { $result.window = $Watch.ElapsedMilliseconds }
        }
        if ($null -eq $result.api -and $Ready.Url) {
            try {
                $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri $Ready.Url
                if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { $result.api = $Watch.ElapsedMilliseconds }
            } catch { }
        }
        $apiDone = ($null -ne $result.api) -or (-not $Ready.Url)
        $winDone = ($null -ne $result.window) -or (-not $Ready.ProcessWindow)
        if ($apiDone -and $winDone) { break }
        Start-Sleep -Milliseconds 100
    }
    return $result
}

function Get-InstallDirPath {
    param($Config)
    return (Resolve-PathValue $Config.InstallDir)
}

function Get-DirSizeBytes {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @{ bytes = 0; files = 0 } }
    $items = @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue)
    $sum = 0.0
    foreach ($i in $items) { $sum += $i.Length }
    return @{ bytes = $sum; files = $items.Count }
}
