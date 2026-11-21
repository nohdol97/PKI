<#
  R04 step 1: preflight. Is this a clean machine (no Node/Python/Docker/DB server installed)? (R04-R1, R04-C1)
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

# 1) Commands that must NOT exist on the clean machine (names only, never paths).
$commandNames = 'node', 'npm', 'python', 'python3', 'py', 'docker', 'psql', 'postgres', 'mysqld', 'mongod', 'sqlservr'
$foundCommands = @()
foreach ($n in $commandNames) {
    if (Get-Command -Name $n -ErrorAction SilentlyContinue) { $foundCommands += $n }
}

# 2) Installed software entries by category (display names are matched, only the category is stored).
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
$observed = "commands found: [{0}]; software categories found: [{1}]; VC++ redistributable present: {2}" -f ($foundCommands -join ','), ($foundSoftware -join ','), $vcRedist
Add-Check $result 'R04-C1:preflight' 'clean Windows 11: no Node/Python/Docker/DB server installed' $verdict $observed 'A FAIL means the machine is not clean; do not continue with the install steps. VC++ redistributable presence is information only (native modules may need it).' @{ commands = $foundCommands; software = $foundSoftware; vc_redist = $vcRedist }
Add-Note $result 'Reboot-level cold start and a snapshot/VM revert before the run are the operator''s job (RUNBOOK.md).'
Save-Result $result $OutDir
if (-not $clean) { exit 1 }
