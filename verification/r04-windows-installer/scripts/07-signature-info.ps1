<#
  R04 step 7: Authenticode signature status of the installer and installed binaries (R04-R7, R04-C3)
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
$installer = Assert-InstallerConfigured $cfg
$result = New-Result

function Get-SigRow {
    param([string]$Path)
    $s = Get-AuthenticodeSignature -LiteralPath $Path
    return [ordered]@{ status = [string]$s.Status; has_signer = ($null -ne $s.SignerCertificate); has_timestamp = ($null -ne $s.TimeStamperCertificate) }
}

$inst = Get-SigRow $installer
Add-Check $result 'R04-C3:signature-installer' $(if ($inst.status -eq 'Valid') { 'PASS' } else { 'INCONCLUSIVE' }) @{ status = $inst.status; has_signer = $inst.has_signer; has_timestamp = $inst.has_timestamp }

$installDir = Get-InstallDirPath $cfg
$counts = [ordered]@{}
$unsigned = @(); $checked = 0
if (Test-Path -LiteralPath $installDir) {
    $files = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Include *.exe, *.dll, *.node, *.sys, *.pyd -ErrorAction SilentlyContinue)
    $checked = $files.Count
    foreach ($f in $files) {
        $row = Get-SigRow $f.FullName
        if ($counts.Contains($row.status)) { $counts[$row.status] = $counts[$row.status] + 1 } else { $counts[$row.status] = 1 }
        if ($row.status -ne 'Valid') { $unsigned += $f.FullName.Substring($installDir.Length) }
    }
    Add-Metric $result 'binary_files_checked' $checked 'files'
}
Add-Check $result 'R04-C3:signature-binaries' 'INCONCLUSIVE' @{ files_checked = $checked; status_counts = $counts; not_valid_count = $unsigned.Count }
Save-RawFile $OutDir 'unsigned-files.json' $unsigned   # names stay local
Save-Result $result $OutDir
