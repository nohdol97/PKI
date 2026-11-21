<#
  R04 step 7: Authenticode signature status of the installer and installed binaries (R04-R7, R04-C3)
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
$installer = Assert-InstallerConfigured $cfg
$result = New-Result

function Get-SigRow {
    param([string]$Path)
    $s = Get-AuthenticodeSignature -LiteralPath $Path
    return [ordered]@{ status = [string]$s.Status; has_signer = ($null -ne $s.SignerCertificate); has_timestamp = ($null -ne $s.TimeStamperCertificate) }
}

$inst = Get-SigRow $installer
Add-Check $result 'R04-C3:signature-installer' 'installer signature status' $(if ($inst.status -eq 'Valid') { 'PASS' } else { 'INCONCLUSIVE' }) ("status {0}; signer present {1}; timestamp present {2}" -f $inst.status, $inst.has_signer, $inst.has_timestamp) 'Unsigned is expected for early skeletons; the signing certificate decision is R04-S3 (checklist).' $inst

$installDir = Get-InstallDirPath $cfg
$counts = [ordered]@{}
$unsigned = @()
if (Test-Path -LiteralPath $installDir) {
    $files = @(Get-ChildItem -LiteralPath $installDir -Recurse -File -Include *.exe, *.dll, *.node, *.sys, *.pyd -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
        $row = Get-SigRow $f.FullName
        if ($counts.Contains($row.status)) { $counts[$row.status] = $counts[$row.status] + 1 } else { $counts[$row.status] = 1 }
        if ($row.status -ne 'Valid' -and $unsigned.Count -lt 100) { $unsigned += $f.FullName.Substring($installDir.Length) }
    }
    Add-Metric $result 'binary_files_checked' $files.Count 'files'
}
Add-Check $result 'R04-C3:signature-binaries' 'signature status of bundled exe/dll/node/sys/pyd files' 'INCONCLUSIVE' (($counts.Keys | ForEach-Object { "{0}={1}" -f $_, $counts[$_] }) -join '; ') 'Native modules and helper binaries that are not signed can be blocked by Smart App Control (sqlite-vec issue 368 is the only observation known; OSS_EVALUATION 4.3). SmartScreen itself is a manual checklist item.' @{ counts = $counts; not_valid = $unsigned }
Save-Result $result $OutDir
