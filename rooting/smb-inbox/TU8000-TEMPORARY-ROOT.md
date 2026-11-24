# TU8000: install Vetro and connect temporary root

This is the temporary-development path for the owner's existing TU8000 root shell. It does **not** make Remote PC run unattended at boot and does not change firmware, boot partitions, UEP, SMACK policy, or the TV's account database.

## What this branch adds

On the Tizen 5.5 / Node 4.4.3 service, Vetro now stages a private one-time root-agent handoff alongside its existing SDB root attempt. The service remains UID 5001. Its root-agent server creates a random session secret and listens on loopback. The owner starts a small supervisor and the Node 4.4 FIFO worker from the already-open `System::Privileged` root shell. The root agent authenticates with Vetro's existing HMAC protocol; Vetro accepts it only after UID, EUID, GID and EGID are all zero.

The launch helper is generated locally by Vetro, stored in a private mode-0700 directory, and SHA-256 checks its agent and worker source before starting them. Every helper/script is invoked by **content**, not by path, to respect the UEP behavior seen on these TVs. The helper does not alter SMACK rules; if the socket is denied by SMACK, collect the agent log and matching denial before deciding on a separate fix.

This is temporary:
- The agent is detached from the interactive root shell and can keep serving while that shell closes.
- Restarting the Vetro service closes the old agent; Vetro creates a fresh one-time handoff that must be started again from a root shell.
- A TV power cycle stops both Vetro and the agent. Vetro will stage a fresh handoff on the next start, but Remote PC/CIFS still has to be opened manually to acquire the root shell.
- No cold-boot persistence hook is installed.

## 1. Get this branch

In PowerShell, from your existing clone:

```powershell
git fetch origin
git switch feature/tu8000-remote-pc-boot-preflight
git pull --ff-only
```

If that branch does not exist locally yet:

```powershell
git switch --track -c feature/tu8000-remote-pc-boot-preflight origin/feature/tu8000-remote-pc-boot-preflight
```

## 2. Build a signed WGT

Use your own Samsung author and distributor certificate files, already associated with this TV. Never commit the P12 files or put their passwords in a source file.

From the repository root, install the build dependencies:

```powershell
Push-Location .\rooting\on-boot-probe
npm ci
Pop-Location
```

Your TV already uses Vetro on port **9000** to avoid the YouTube app's port. Keep that port in this build:

```powershell
$env:VETRO_PORT = '9000'
$env:AUTHOR_P12 = 'C:\path\to\your\author.p12'
$env:DIST_P12 = 'C:\path\to\your\distributor.p12'
$env:AUTHOR_PW = Read-Host 'Author certificate password'
$env:DIST_PW = Read-Host 'Distributor certificate password'
$env:OUT = Join-Path $PWD 'dist\vetro-tu8000-temporary-root.wgt'
node .\rooting\build.cjs
```

Enter the certificate passwords locally in PowerShell; do not paste them into chat or commit them. If you already use the repository's default certificate paths, set `AUTHOR_P12` and `DIST_P12` to those files. Keep the current certificate profile used to install Vetro if possible, so Tizen can update the existing package rather than treating it as a different signer.

The builder signs the WGT using your certificates and includes the current integration. It does not install anything on the TV.

## 3. Install over the existing Vetro

Keep Developer Mode **Host PC IP = 10.0.0.56** while installing from your Windows PC. Do not change it to `127.0.0.1` for this temporary CIFS handoff; the temporary agent talks to Vetro over the TV's own loopback socket and does not depend on PC-side SDB authorization.

Connect and verify your TV target:

```powershell
& $sdb.FullName connect 10.0.0.167:26101
& $sdb.FullName devices
```

Install the signed WGT using your configured Tizen CLI target:

```powershell
& $tizen.FullName install -n $env:OUT -t YOUR_TV_TARGET
```

Use the target identifier shown by your Tizen Studio device manager. Do not use `sdb install`. If Apps2Samsung is how you normally install custom WGTs, use its local-package installation path and the same TV certificate profile.

Open Vetro once on the TV. From Windows, check:

```powershell
$status = Invoke-RestMethod 'http://10.0.0.167:9000/status'
$status.manualRoot | Format-List
$status.rooting | Format-List
$status.agent | Format-List
```

Wait until `manualRoot.available` is true and `manualRoot.bootstrapPath` is populated. The SDB backend may still report `sdbClosed`; that is separate from the temporary handoff.

## 4. Start temporary root from your existing TV root shell

Open the same Remote PC/CIFS root shell you already use. Confirm it still reports UID 0 and `System::Privileged`. Then set `P` to the exact `manualRoot.bootstrapPath` value returned by Vetro's `/status`:

```sh
P='/home/owner/share/tmp/sdk_tools/archive-root-REPLACE_WITH_CURRENT_ID/manual-root/start.sh'
/bin/sh -c "$(cat "$P")" vetro-temporary-root
```

Replace the example path with the exact current value from `/status`. Do not run `/bin/sh "$P"` or execute the file by path; the content invocation is intentional for UEP.

The helper should print the worker and agent PIDs plus log paths. Then refresh `http://10.0.0.167:9000/status`:

```powershell
$status = Invoke-RestMethod 'http://10.0.0.167:9000/status'
$status.agent | Format-List
$status.rooting | Format-List
```

The success condition is an authenticated connection with `agent.connected = true`, `agent.uid = 0`, `agent.gid = 0`, nonzero `cap_eff`, and the reported SMACK label. That is what makes Vetro's root-backed features available for the current session. A running Vetro dashboard alone is not root.

## 5. If the agent does not connect

Use the log paths printed by the helper in the root shell. The filenames contain the run ID; inspect the matching `agent-*.log`, `node-*.console`, and `worker-*.log` under the current `manual-root` directory.

Do not apply a guessed SMACK rule. In the first attempt, preserve:
- the new `/status` response;
- the agent log and node console;
- the output of `cat /proc/self/attr/current` in the root shell;
- only the matching SMACK-denial lines from `dmesg`, if there are any.

A connection refusal, a SMACK denial, an agent authentication rejection, and a worker startup failure are different problems and need different fixes.

## 6. Stop temporary root

The root agent closes when the Vetro service stops or restarts. To stop it before that, use the agent PID from the helper output in your existing root shell:

```sh
kill AGENT_PID
```

Vetro will show the agent disconnected. No firmware or persistent boot files are changed by this temporary mode.

## Current limits

- Tested in source/static checks only so far; not yet built, installed, or run on the TU8000.
- The current Tizen 5.5 root payload path still has its separate .NET 3.0/UEP/SMACK considerations; this manual route uses the bundled Node 4.4 FIFO agent.
- The loopback TCP connection may still encounter a firmware-specific SMACK rule. The first run is a diagnostic test, not a claim that the agent will connect.
- Temporary root does not automatically return after TV power-off, Vetro service restart, or loss of the root agent. Reopen the existing Remote PC/CIFS root shell and rerun the current bootstrap path when needed.
- The boot-persistent Remote PC supervisor remains a separate, firmware-specific project. The read-only TU8000 preflight is still required before considering that step.
