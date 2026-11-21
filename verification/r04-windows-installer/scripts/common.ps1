<#
  R04 shared functions. STATUS: WRITTEN OFF-SITE, NEVER EXECUTED and not even syntax-checked
  (no PowerShell was available where this was written). Windows PowerShell 5.1 syntax only.
  Dot-source from the numbered scripts:  . (Join-Path $PSScriptRoot 'common.ps1')

  Result object = the same schema as the R02/R03 result.json (schema_version 1). Every string is passed
  through Redact-Text before it is written. sanitize_result.py masks it a second time on another machine.
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

# ---- redaction (first line of defence; sanitize_result.py is the second) --------------------------
function Redact-Text {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $literals = @(
        @($env:USERPROFILE, '<HOME>'),
        @($env:COMPUTERNAME, '<HOST>'),
        @($env:USERDOMAIN, '<HOST>'),
        @($env:USERNAME, '<USER>')
    )
    foreach ($pair in $literals) {
        $lit = [string]$pair[0]
        if ($lit.Length -ge 3) {
            $Text = [regex]::Replace($Text, [regex]::Escape($lit), [string]$pair[1], [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }
    $Text = [regex]::Replace($Text, '[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'']+', '<HOME>')
    $Text = [regex]::Replace($Text, '\\\\[^\\\s"'']+\\[^\s"'']*', '<UNC>')
    $Text = [regex]::Replace($Text, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', '<EMAIL>')
    $Text = [regex]::Replace($Text, '\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b', '<IP>')
    return $Text
}

function Redact-Object {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return (Redact-Text $Value) }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($k in $Value.Keys) { $copy[(Redact-Text ([string]$k))] = Redact-Object $Value[$k] }
        return $copy
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $list = New-Object System.Collections.ArrayList
        foreach ($item in $Value) { [void]$list.Add((Redact-Object $item)) }
        return ,$list.ToArray()
    }
    return $Value
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
    param($Result, [string]$Id, [string]$Criterion, [string]$Verdict, [string]$Observed, [string]$Note = '', $Data = $null)
    $valid = @('PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_RUN', 'NOT_APPLICABLE')
    if ($valid -notcontains $Verdict) { throw "bad verdict $Verdict" }
    $check = [ordered]@{ id = $Id; criterion = $Criterion; verdict = $Verdict; observed = $Observed; note = $Note }
    if ($null -ne $Data) { $check['data'] = $Data }
    [void]$Result.checks.Add($check)
}

function Add-Metric {
    param($Result, [string]$Name, $Value, [string]$Unit = '')
    $Result.metrics[$Name] = [ordered]@{ value = $Value; unit = $Unit }
}

function Add-Note {
    param($Result, [string]$Text)
    [void]$Result.notes.Add($Text)
}

function Save-Result {
    # Merges into an existing result.json of the same kit (same check ids are replaced), redacts, writes UTF-8 without BOM.
    param($Result, [string]$OutDir)
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $path = Join-Path $OutDir 'result.json'
    if (Test-Path -LiteralPath $path) {
        $old = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
        if ($old.kit -eq $script:KitName) {
            $have = @($Result.checks | ForEach-Object { $_.id })
            $kept = @($old.checks | Where-Object { $have -notcontains $_.id })
            $merged = New-Object System.Collections.ArrayList
            foreach ($c in $kept) { [void]$merged.Add($c) }
            foreach ($c in $Result.checks) { [void]$merged.Add($c) }
            $Result.checks = $merged
            foreach ($prop in $old.metrics.PSObject.Properties) {
                if (-not $Result.metrics.Contains($prop.Name)) { $Result.metrics[$prop.Name] = $prop.Value }
            }
        }
    }
    $clean = Redact-Object $Result
    $json = ConvertTo-Json -InputObject $clean -Depth 8
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("wrote {0}  (run sanitize_result.py on it before pasting anything)" -f $path)
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
    if ($Values.Count -eq 0) { return 0 }
    $sorted = $Values | Sort-Object
    $index = [math]::Min($sorted.Count - 1, [math]::Ceiling($P / 100.0 * $sorted.Count) - 1)
    return $sorted[[math]::Max(0, $index)]
}

function Stop-ProductProcesses {
    param([string]$ProcessName, [string[]]$ExtraNames = @())
    foreach ($n in (@($ProcessName) + $ExtraNames)) {
        Get-Process -Name ($n -replace '\.exe$', '') -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReadyProbe {
    # Returns @{ api = ms or $null; window = ms or $null } polling until timeout.
    param($Process, $Ready, [System.Diagnostics.Stopwatch]$Watch)
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
