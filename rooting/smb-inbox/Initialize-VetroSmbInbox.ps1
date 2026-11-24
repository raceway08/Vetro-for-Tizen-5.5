[CmdletBinding()]
param(
    [string]$SharePath = '\\10.0.0.56\TVShareTest\VetroInbox',
    [string]$KeyDirectory = (Join-Path $env:APPDATA 'Vetro\SmbInbox'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if (-not (Test-Path -LiteralPath $SharePath -PathType Container)) {
    New-Item -ItemType Directory -Path $SharePath -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $KeyDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $KeyDirectory -Force | Out-Null
}

$privateKeyPath = Join-Path $KeyDirectory 'private.pem'
$publicKeyPath = Join-Path $SharePath 'public.pem'
$runnerSource = Join-Path $PSScriptRoot 'run-vetro-smb-inbox.sh'
$runnerTarget = Join-Path $SharePath 'run-vetro-smb-inbox.sh'

if ((Test-Path -LiteralPath $privateKeyPath) -and -not $Force) {
    throw "A signing key already exists at $privateKeyPath. Use -Force only to replace it; replacing it requires re-pinning public.pem on the TV."
}

$rsa = [System.Security.Cryptography.RSA]::Create()\n$rsa.KeySize = 3072
try {
    [System.IO.File]::WriteAllText($privateKeyPath, $rsa.ExportPkcs8PrivateKeyPem(), $utf8NoBom)
    [System.IO.File]::WriteAllText($publicKeyPath, $rsa.ExportSubjectPublicKeyInfoPem(), $utf8NoBom)
}
finally {
    $rsa.Dispose()
}

# AppData is user-private by default. Do not copy private.pem to the SMB share.
if (-not (Test-Path -LiteralPath $runnerSource -PathType Leaf)) {
    throw "Runner source is missing: $runnerSource"
}
Copy-Item -LiteralPath $runnerSource -Destination $runnerTarget -Force

Write-Host ''
Write-Host 'Vetro SMB inbox initialized.' -ForegroundColor Green
Write-Host "Private signing key (keep on this PC): $privateKeyPath"
Write-Host "Public verification key (copied to SMB): $publicKeyPath"
Write-Host "Inbox share: $SharePath"
Write-Host ''
Write-Host 'Run this once in the existing TV root shell to pin the public key locally:'
Write-Host 'mkdir -p /opt/usr/home/owner/share/vetro-smb-inbox'
Write-Host 'cp /opt/usr/home/owner/content/smb/TVShareTest/VetroInbox/public.pem /opt/usr/home/owner/share/vetro-smb-inbox/public.pem'
Write-Host 'chmod 600 /opt/usr/home/owner/share/vetro-smb-inbox/public.pem'
Write-Host ''
Write-Host 'The private key stays in AppData. Never place it on the SMB share or in Git.'
