[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Command,

    [string]$SharePath = '\\10.0.0.56\TVShareTest\VetroInbox',
    [string]$PrivateKeyPath = (Join-Path $env:APPDATA 'Vetro\SmbInbox\private.pem'),
    [ValidateRange(1, 60)]
    [int]$ExpiresMinutes = 10
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if ($Command.Length -gt 4096 -or $Command -match '[^\x20-\x7E]') {
    throw 'Command must be a single printable-ASCII line of at most 4096 characters.'
}
if (-not (Test-Path -LiteralPath $SharePath -PathType Container)) {
    throw "SMB inbox not found: $SharePath. Run Initialize-VetroSmbInbox.ps1 first."
}
if (-not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)) {
    throw "Private signing key not found: $PrivateKeyPath. Run Initialize-VetroSmbInbox.ps1 first."
}

$rsa = [System.Security.Cryptography.RSA]::Create()
try {
    $rsa.ImportFromPem([System.IO.File]::ReadAllText($PrivateKeyPath))
    $id = [Guid]::NewGuid().ToString('N')
    $expires = [DateTimeOffset]::UtcNow.AddMinutes($ExpiresMinutes).ToUnixTimeSeconds()
    $commandBytes = [System.Text.Encoding]::ASCII.GetBytes($Command)
    $commandB64 = [Convert]::ToBase64String($commandBytes)

    # The exact first four lines, including the final newline, are signed.
    $lf = [char]10
    $payload = 'VETRO-SMB-JOB/1' + $lf + $id + $lf + $expires + $lf + $commandB64 + $lf
    $payloadBytes = [System.Text.Encoding]::ASCII.GetBytes($payload)
    $signature = $rsa.SignData(
        $payloadBytes,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $envelope = $payload + [Convert]::ToBase64String($signature) + $lf
}
finally {
    $rsa.Dispose()
}

$destination = Join-Path $SharePath 'run.vjob'
$temp = Join-Path $SharePath ('.run.vjob.tmp-' + $id)
[System.IO.File]::WriteAllText($temp, $envelope, $utf8NoBom)
Move-Item -LiteralPath $temp -Destination $destination -Force

Write-Host "Queued signed Vetro job $id"
Write-Host "Expires UTC: $([DateTimeOffset]::FromUnixTimeSeconds($expires).UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "Inbox file: $destination"
Write-Host 'The TV worker will execute it once after validating the RSA signature.'
