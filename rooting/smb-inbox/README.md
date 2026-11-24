# Vetro signed SMB command inbox (experimental)

This helper is for a TV where you **already have an independent root shell**. It does not obtain root, repair Vetro's SDB handshake, change UEP/SMACK policy, or make the Vetro UI run as root.

It gives you one simple drop location on the existing Windows SMB share:

```text
\\10.0.0.56\TVShareTest\VetroInbox\run.vjob
```

A small root-side watcher reads that file, verifies an RSA-SHA256 signature against a public key pinned on the TV's local storage, checks expiry and replay ID, and only then runs the signed one-line command as UID 0. The SMB mount can remain `ro,nosuid,nodev,noexec`: the watcher reads the job as data and passes the verified command to `/bin/sh -c`; it does not execute a file directly from the SMB mount.

**Important signing distinction:** the job envelope is signed by your own RSA key. This is not a Samsung platform signature, and it does not sign the program binary. `/usr/bin/dotnet-launcher` is the Samsung-provided signed host; a DLL loaded by it is still your program. The command is authenticated, but if you run a DLL from a share that other people can modify, they could replace that DLL. Keep the share private, or copy and verify program files separately before running them.

## 1. Put the helper files on the SMB share

From this folder in your Git checkout, run the setup script in PowerShell 7:

```powershell
.\Initialize-VetroSmbInbox.ps1
```

It creates the inbox folder if needed, generates a 3072-bit RSA key pair, keeps `private.pem` under your Windows `%APPDATA%\Vetro\SmbInbox` directory, and copies only `public.pem` and the shell watcher to the SMB share. Do not copy `private.pem` to the share or commit it to Git.

To use a different share path:

```powershell
.\Initialize-VetroSmbInbox.ps1 -SharePath '\\10.0.0.56\TVShareTest\VetroInbox'
```

The TV public key and watcher must be copied to local storage and fingerprint-checked **before running anything as root**. The setup script prints the expected SHA-256 hashes for both files. In your existing TV root shell:

```sh
INBOX=/opt/usr/home/owner/content/smb/TVShareTest/VetroInbox
STATE=/opt/usr/home/owner/share/vetro-smb-inbox
mkdir -p "$STATE"
chmod 700 "$STATE"
cp "$INBOX/public.pem" "$STATE/public.pem"
cp "$INBOX/run-vetro-smb-inbox.sh" "$STATE/runner.sh"
openssl dgst -sha256 "$STATE/public.pem"
openssl dgst -sha256 "$STATE/runner.sh"
```

Compare the two hash values printed by OpenSSL with the **Public key SHA-256** and **Runner SHA-256** values printed by `Initialize-VetroSmbInbox.ps1` on Windows. Do not continue unless both match exactly. Then:

```sh
chmod 600 "$STATE/public.pem" "$STATE/runner.sh"
```

The local copies are now independent of later changes to the SMB share. The public key is pinned off the share, and the watcher code is run from the TV's local storage, not directly from the share.

## 2. Start the watcher from the existing root shell

Run this once in the root shell after verifying both hashes. Invoke the script by **content**, not as `/bin/sh /path/to/runner.sh`: UEP-protected Tizen builds can reject a script loaded by path even when the caller is UID 0.

```sh
/usr/bin/setsid /bin/sh -c "$(cat "$STATE/runner.sh")" vetro-smb-inbox "$INBOX" "$STATE/public.pem" "$STATE" \
  </dev/null >"$STATE/console.log" 2>&1 &
```

Check that it started:

```sh
cat /opt/usr/home/owner/share/vetro-smb-inbox/console.log
cat /opt/usr/home/owner/share/vetro-smb-inbox/runner.pid
```

Stop it by sending `TERM` to the PID in `runner.pid`:

```sh
kill "$(cat /opt/usr/home/owner/share/vetro-smb-inbox/runner.pid)"
```

The watcher does not survive a TV reboot. It only works while the existing root context and SMB mount are available. The content-based invocation requirement also applies to any helper script the watcher launches.

## 3. Submit a signed command from Windows

Use PowerShell 7 and the private key created during setup:

```powershell
.\New-VetroSmbCommand.ps1 -Command 'id; cat /proc/self/attr/current'
```

The script writes a single `run.vjob` file atomically. It defaults to a 10-minute expiry; the allowed setting is 1–60 minutes. The watcher accepts a job once, records its random ID on local TV storage, and writes output to:

```text
/opt/usr/home/owner/share/vetro-smb-inbox/jobs/<job-id>.log
```

Use the job ID printed by PowerShell to inspect the matching log from the root shell. Only one job slot is provided: wait for a job to finish before submitting another.

Example invoking Samsung's signed .NET host:

```powershell
.\New-VetroSmbCommand.ps1 -Command '/usr/bin/dotnet-launcher --standalone /opt/usr/home/owner/content/smb/TVShareTest/VetroInbox/MyTool.dll'
```

Place `MyTool.dll` and its matching `.runtimeconfig.json`, `.deps.json`, and dependency files in the inbox first. The job command is RSA-signed; the DLL contents are not automatically hashed by this helper.

## Security and limits

- This intentionally provides root command execution to whoever holds the Windows private key. Protect that key. Anyone who steals it can submit root jobs.
- Keep the SMB share restricted to your trusted LAN. Do not expose it through router port forwarding, Cloudflare Tunnel, or the public internet.
- The TV trusts only the public key copied to local storage. Replacing/rotating the key requires repeating the local pinning step.
- Commands are one printable-ASCII line, at most 4096 bytes. Jobs expire, are RSA-SHA256 verified, and are recorded before execution to avoid automatic replay after interruption.
- The watcher processes one command at a time and waits for it to exit. There is no automatic retry if the result is uncertain.
- Logs and replay markers are stored locally on the TV, not written back to the SMB share (the Remote PC mount is read-only).
- This is an experimental helper, not an integrated Vetro root backend. It does not fix the current `sdbClosed` status or establish persistence across reboot.
