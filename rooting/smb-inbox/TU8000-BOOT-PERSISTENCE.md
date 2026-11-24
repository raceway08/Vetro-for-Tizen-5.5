# TU8000 Remote PC/CIFS boot-persistence preflight

**This is a read-only first test, not an automatic-root installer.** It gathers the exact device and firmware evidence needed before choosing a boot-persistence design.

## Why this check comes first

The current Vetro package already declares its web service with `on-boot="true"` and `auto-restart="true"` in `app/config.xml`. That starts Vetro; it does not grant root.

The current TV adapter is still `sdb-archive`. The signed SMB inbox helper is a manual command channel for a root shell that already exists. Neither one installs the root-at-boot mechanism.

The community Q74T report describes a different design: a firmware-specific boot hook starts a supervisor, and that supervisor waits for a launch request created by the Vetro service. It also reports two important runtime constraints: script files must be invoked by content at every level under UEP, and SMACK may need an explicit rule for the root agent's loopback connection. Those are device-tested findings on a Q74T, not proof for a TU8000.

The boot hook in that report patches a vendor file inside the read-only root filesystem. The author explicitly did not publish a drop-in installer because the byte offset is specific to each firmware image and a wrong offset can brick the TV. This branch therefore does **not** write a block device, patch `/etc/profile.d`, modify account files, disable UEP, or change SMACK policy.

## Test 1 — collect the TU8000 facts

Copy `tu8000-remote-pc-preflight.sh` to your existing Windows SMB share, for example:

```text
\\10.0.0.56\TVShareTest\VetroInbox\tu8000-remote-pc-preflight.sh
```

Then, in your already-open TV root shell, run the script by **content** (not by script path). This matters on UEP-protected builds:

```sh
P=/opt/usr/home/owner/content/smb/TVShareTest/VetroInbox/tu8000-remote-pc-preflight.sh
/bin/sh -c "$(cat "$P")" vetro-tu8000-preflight
```

The script prints:
- current shell UID/GID, effective capabilities and SMACK label;
- only model/firmware-related keys from common system information files;
- the Node and OpenSSL versions;
- size, owner/mode and SHA-256 of `mount.smb.sh`;
- size, owner/mode and SHA-256 of `/etc/profile.d/bash_prompt_custom.sh`;
- the root filesystem mount line and read-only partition inventory.

It does not print the SMB password, private signing key, serial number, MAC address, full configuration files, or command history. It does not create or modify files, invoke Remote PC, reboot, or write to a partition.

Send back the complete output. The model/firmware identity and both hashes are the key compatibility evidence.

## Test 2 — what must be established before boot persistence

After Test 1, the next checks are:

1. Confirm the exact model code and firmware build. "Tizen 5.5" alone is not a firmware match.
2. Compare the privileged helper and profile carrier with the known Tizen 5.5 reports. A matching helper hash alone does not prove the whole Remote PC input path works.
3. Obtain and verify the official firmware image for the exact model/region/build, then locate the carrier and root filesystem geometry offline. Do not reuse an offset from a TU7000, TU8500, Q60T, or Q74T.
4. Build and test the supervisor and authenticated job channel offline first, including symlink rejection, exact service-UID ownership, atomic claiming, per-boot locking, bounded output, and restart handling.
5. Only after the exact image, full backup, and readback/rollback design are independently verified should an on-device persistence installer even be considered.

## What success eventually looks like

A real cold-boot test must show all of the following without opening Remote PC or Vetro manually:
- boot ID changes;
- Vetro service starts;
- root agent reconnects and reports UID 0 with the expected security context;
- a harmless authenticated identity request returns the same UID and context;
- the connection survives Vetro service restart and a later cold boot.

A running HTTP `/status` endpoint alone is not proof of root. A process PID alone is not proof of the right credentials or SMACK label.

## Evidence boundary

- [TU7000 report #95](https://github.com/andrearicci93/vetro/issues/95) is a locally modified Tizen 5.5 build on a different model and firmware.
- [Q74T report #114](https://github.com/andrearicci93/vetro/issues/114) describes the boot supervisor design and hardware-specific UEP/SMACK fixes on a different Tizen 5.5 model and firmware.
- The current Vetro SDB failure on this TU8000 remains separate. This preflight does not fix `sdbClosed`.

Do not treat a passing read-only preflight as proof that boot persistence is compatible.
