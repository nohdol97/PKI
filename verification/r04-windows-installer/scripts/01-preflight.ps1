<#
  R04 step 1: preflight. Is this a clean machine (no Node/Python/Docker/DB server installed)? (R04-R1, R04-C1)
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

# 1) Commands that must NOT exist on the clean machine. Windows 11 ships Store alias stubs named python.exe /
#    python3.exe under WindowsApps; those are not installed runtimes and are ignored (counted separately).
$commandNames = 'node', 'npm', 'python', 'python3', 'py', 'docker', 'psql', 'postgres', 'mysqld', 'mongod', 'sqlservr'
$foundCommands = @(); $storeAliases = 0
foreach ($n in $commandNames) {
    foreach ($cmd in @(Get-Command -Name $n -CommandType Application -ErrorAction SilentlyContinue)) {
        if ($cmd.Source -like '*\Microsoft\WindowsApps\*') { $storeAliases++ } elseif ($foundCommands -notcontains $n) { $foundCommands += $n }
    }
}

# 2) Installed software entries by category (display names are matched; only the fixed category word is kept).
$keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
$names = @()
foreach ($k in $keys) {
    $names += @(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | ForEach-Object { $_.DisplayName } | Where-Object { $_ })
}
$categories = [ordered]@{
    'node'      = 'Node\.js'
    'python'    = '^Python \d'
    'docker'    = 'Docker'
    'postgres'  = 'PostgreSQL'
    'mysql'     = 'MySQL|MariaDB'
    'mongodb'   = 'MongoDB'
    'sqlserver' = 'SQL Server'
}
$foundSoftware = @()
foreach ($c in $categories.Keys) {
    if ($names | Where-Object { $_ -match $categories[$c] }) { $foundSoftware += $c }
}
$vcRedist = [bool]($names | Where-Object { $_ -match 'Visual C\+\+.*Redistributable' })

$clean = ($foundCommands.Count -eq 0) -and ($foundSoftware.Count -eq 0)
$verdict = if ($clean) { 'PASS' } else { 'FAIL' }
$codes = @(); if (-not $clean) { $codes += 'r04_clean_check_failed' }
Add-Check $result 'R04-C1:preflight' $verdict @{ commands_found = $foundCommands; software_found = $foundSoftware; store_alias_stubs_ignored = $storeAliases; vc_redist_present = $vcRedist } $codes
Add-Note $result 'r04_not_syntax_checked'
Save-Result $result $OutDir
if (-not $clean) { exit 1 }
