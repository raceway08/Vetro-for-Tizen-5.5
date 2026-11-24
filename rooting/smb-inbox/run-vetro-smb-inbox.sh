#!/bin/sh
# Vetro SMB signed-command inbox. Run this as root through /bin/sh -c;
# the SMB mount itself can remain ro,nosuid,nodev,noexec.
set -u

INBOX=${1:-/opt/usr/home/owner/content/smb/TVShareTest/VetroInbox}
PUBLIC_KEY=${2:-/opt/usr/home/owner/share/vetro-smb-inbox/public.pem}
STATE_DIR=${3:-/opt/usr/home/owner/share/vetro-smb-inbox}
POLL_SECONDS=2
MAX_JOB_BYTES=16384
MAX_COMMAND_BYTES=4096
MAX_FUTURE_SECONDS=3600

log() {
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" "$*" >> "$STATE_DIR/runner.log"
}

if [ "$(id -u 2>/dev/null)" != "0" ]; then
    echo 'ERROR: this inbox worker must be started from the existing root shell.' >&2
    exit 1
fi

if [ ! -d "$INBOX" ]; then
    echo "ERROR: SMB inbox directory not found: $INBOX" >&2
    exit 1
fi
if [ ! -r "$PUBLIC_KEY" ]; then
    echo "ERROR: pinned public key is not readable: $PUBLIC_KEY" >&2
    exit 1
fi
OPENSSL=$(command -v openssl 2>/dev/null || true)
if [ -z "$OPENSSL" ]; then
    echo 'ERROR: openssl is required for RSA signature verification.' >&2
    exit 1
fi

umask 077
mkdir -p "$STATE_DIR/seen" "$STATE_DIR/jobs" "$STATE_DIR/work" || exit 1
chmod 700 "$STATE_DIR" "$STATE_DIR/seen" "$STATE_DIR/jobs" "$STATE_DIR/work" 2>/dev/null || true
WORK="$STATE_DIR/work/inbox-$$"
mkdir -m 700 "$WORK" || exit 1
printf '%s\n' "$$" > "$STATE_DIR/runner.pid"
chmod 600 "$STATE_DIR/runner.pid" 2>/dev/null || true
trap 'rm -f "$STATE_DIR/runner.pid"; rm -rf "$WORK"' EXIT
trap 'exit 0' HUP INT TERM

CONTEXT=$(cat /proc/self/attr/current 2>/dev/null || true)
if [ "$CONTEXT" != "System::Privileged" ]; then
    echo "ERROR: expected SMACK System::Privileged, got: $CONTEXT" >&2
    exit 1
fi
log "START uid=$(id -u) context=$CONTEXT inbox=$INBOX"
echo "Vetro SMB inbox ready; jobs are read from $INBOX/run.vjob"
echo "Local logs: $STATE_DIR/jobs/"

reject_job() {
    FINGERPRINT=$("$OPENSSL" dgst -sha256 "$WORK/snapshot" 2>/dev/null | awk '{print $NF}')
    REJECT_MARKER="$STATE_DIR/seen/rejected-$FINGERPRINT"
    if [ -n "$FINGERPRINT" ] && [ ! -f "$REJECT_MARKER" ]; then
        : > "$REJECT_MARKER"
        log "REJECT id=${JOB_ID:-unknown} reason=$1"
    fi
    rm -f "$WORK/snapshot" "$WORK/payload" "$WORK/signature.der" "$WORK/command.bin"
}

while :; do
    JOB_FILE="$INBOX/run.vjob"
    if [ ! -f "$JOB_FILE" ] || [ -L "$JOB_FILE" ]; then
        sleep "$POLL_SECONDS"
        continue
    fi

    rm -f "$WORK/snapshot" "$WORK/payload" "$WORK/signature.der" "$WORK/command.bin"
    if ! cp "$JOB_FILE" "$WORK/snapshot" 2>/dev/null; then
        sleep "$POLL_SECONDS"
        continue
    fi

    SIZE=$(wc -c < "$WORK/snapshot" | tr -d ' ')
    if [ -z "$SIZE" ] || [ "$SIZE" -gt "$MAX_JOB_BYTES" ] || [ "$SIZE" -lt 20 ]; then
        JOB_ID=unknown
        reject_job invalid-size
        sleep "$POLL_SECONDS"
        continue
    fi

    LINES=$(awk 'END { print NR }' "$WORK/snapshot" 2>/dev/null)
    HEADER=$(sed -n '1p' "$WORK/snapshot")
    JOB_ID=$(sed -n '2p' "$WORK/snapshot")
    EXPIRES=$(sed -n '3p' "$WORK/snapshot")
    COMMAND_B64=$(sed -n '4p' "$WORK/snapshot")
    SIGNATURE_B64=$(sed -n '5p' "$WORK/snapshot")

    if [ "$LINES" != "5" ] || [ "$HEADER" != "VETRO-SMB-JOB/1" ]; then
        reject_job bad-envelope
        sleep "$POLL_SECONDS"
        continue
    fi
    case "$JOB_ID" in ''|*[!a-f0-9]*) reject_job bad-id; sleep "$POLL_SECONDS"; continue ;; esac
    if [ "${#JOB_ID}" -ne 32 ]; then
        reject_job bad-id-length
        sleep "$POLL_SECONDS"
        continue
    fi
    case "$EXPIRES" in ''|*[!0-9]*) reject_job bad-expiry; sleep "$POLL_SECONDS"; continue ;; esac
    case "$COMMAND_B64" in ''|*[!A-Za-z0-9+/=]*) reject_job bad-command-encoding; sleep "$POLL_SECONDS"; continue ;; esac
    case "$SIGNATURE_B64" in ''|*[!A-Za-z0-9+/=]*) reject_job bad-signature-encoding; sleep "$POLL_SECONDS"; continue ;; esac

    NOW=$(date +%s 2>/dev/null)
    case "$NOW" in ''|*[!0-9]*) reject_job clock-unavailable; sleep "$POLL_SECONDS"; continue ;; esac
    if [ "$EXPIRES" -lt "$NOW" ] || [ "$EXPIRES" -gt "$((NOW + MAX_FUTURE_SECONDS))" ]; then
        reject_job expired-or-too-far-future
        sleep "$POLL_SECONDS"
        continue
    fi

    if [ -f "$STATE_DIR/seen/$JOB_ID" ]; then
        sleep "$POLL_SECONDS"
        continue
    fi

    sed -n '1,4p' "$WORK/snapshot" > "$WORK/payload"
    if ! printf '%s' "$SIGNATURE_B64" | base64 -d > "$WORK/signature.der" 2>/dev/null; then
        reject_job invalid-signature-base64
        sleep "$POLL_SECONDS"
        continue
    fi
    if ! "$OPENSSL" dgst -sha256 -verify "$PUBLIC_KEY" -signature "$WORK/signature.der" "$WORK/payload" >/dev/null 2>&1; then
        reject_job signature-check-failed
        sleep "$POLL_SECONDS"
        continue
    fi

    if ! printf '%s' "$COMMAND_B64" | base64 -d > "$WORK/command.bin" 2>/dev/null; then
        reject_job invalid-command-base64
        sleep "$POLL_SECONDS"
        continue
    fi
    COMMAND_SIZE=$(wc -c < "$WORK/command.bin" | tr -d ' ')
    if [ -z "$COMMAND_SIZE" ] || [ "$COMMAND_SIZE" -lt 1 ] || [ "$COMMAND_SIZE" -gt "$MAX_COMMAND_BYTES" ]; then
        reject_job invalid-command-size
        sleep "$POLL_SECONDS"
        continue
    fi
    # Only one printable ASCII line is accepted. This avoids NUL/newline
    # ambiguities when the verified command is passed to /bin/sh -c.
    NONPRINT=$(LC_ALL=C tr -d ' -~' < "$WORK/command.bin" | wc -c | tr -d ' ')
    if [ "$NONPRINT" != "0" ]; then
        reject_job command-not-printable-single-line
        sleep "$POLL_SECONDS"
        continue
    fi
    COMMAND=$(cat "$WORK/command.bin")
    if [ -z "$COMMAND" ]; then
        reject_job empty-command
        sleep "$POLL_SECONDS"
        continue
    fi

    # Mark before dispatch: at-most-once behavior is safer than silently
    # repeating a system-changing job if the worker is interrupted.
    : > "$STATE_DIR/seen/$JOB_ID"
    chmod 600 "$STATE_DIR/seen/$JOB_ID" 2>/dev/null || true
    LOG_FILE="$STATE_DIR/jobs/$JOB_ID.log"
    (
        printf 'VETRO_JOB_ID=%s\n' "$JOB_ID"
        printf 'START_UTC=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
        printf 'RUN_AS_UID=%s\n' "$(id -u)"
        printf 'RUN_AS_GID=%s\n' "$(id -g)"
        printf 'SMACK=%s\n' "$(cat /proc/self/attr/current 2>/dev/null)"
        printf 'CAP_EFF=%s\n' "$(awk '/^CapEff:/ {print $2}' /proc/self/status 2>/dev/null)"
        /bin/sh -c "$COMMAND"
        RC=$?
        printf 'EXIT_CODE=%s\n' "$RC"
        printf 'END_UTC=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
        exit "$RC"
    ) > "$LOG_FILE" 2>&1
    RC=$?
    chmod 600 "$LOG_FILE" 2>/dev/null || true
    log "COMPLETE id=$JOB_ID exit=$RC log=$LOG_FILE"
    echo "Vetro SMB job $JOB_ID finished with exit code $RC; log: $LOG_FILE"
    sleep "$POLL_SECONDS"
done
