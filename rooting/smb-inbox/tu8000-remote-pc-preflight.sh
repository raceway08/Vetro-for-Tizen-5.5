#!/bin/sh
# Read-only Tizen 5.5 Remote PC/CIFS boot-persistence preflight.
# Invoke by content on UEP-protected builds:
#   /bin/sh -c "$(cat /path/to/this-script)" vetro-tu8000-preflight
set -u

section() {
    printf '\n===== %s =====\n' "$1"
}

hash_file() {
    path=$1
    if [ ! -e "$path" ]; then
        printf 'MISSING %s\n' "$path"
        return
    fi
    ls -ldn "$path" 2>/dev/null || true
    bytes=$(wc -c < "$path" 2>/dev/null | tr -d ' ')
    printf 'BYTES %s %s\n' "${bytes:-unknown}" "$path"
    if command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$path" 2>/dev/null || true
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$path" 2>/dev/null || true
    else
        printf 'NO_SHA256_TOOL\n'
    fi
}

section "FORMAT"
printf 'VETRO-REMOTEPC-PREFLIGHT/1\n'
printf 'READ_ONLY=true\n'

section "CURRENT ROOT SHELL"
id 2>&1 || true
printf 'SMACK='
cat /proc/self/attr/current 2>/dev/null || printf 'unavailable\n'
awk '/^(Uid|Gid|CapEff):/ {print}' /proc/self/status 2>/dev/null || true

section "TV MODEL AND FIRMWARE KEYS"
for f in /etc/info.ini /etc/tizen-release /etc/version /etc/sw-version /etc/release; do
    [ -r "$f" ] || continue
    printf -- '-- %s --\n' "$f"
    case "$f" in
        */info.ini)
            awk -F '=' '
                {
                    key=tolower($1)
                    gsub(/[ _-]/, "", key)
                    if (key=="model" || key=="modelname" || key=="modelcode" ||
                        key=="firmware" || key=="firmwareversion" ||
                        key=="tizenversion" || key=="platform" ||
                        key=="systemversion") print $0
                }
            ' "$f" 2>/dev/null
            ;;
        *)
            head -c 256 "$f" 2>/dev/null
            printf '\n'
            ;;
    esac
done

section "TIZEN RUNTIME"
uname -r 2>/dev/null || true
if [ -x /usr/bin/node ]; then
    /usr/bin/node --version 2>&1 || true
fi
if command -v openssl >/dev/null 2>&1; then
    openssl version 2>&1 || true
fi

section "REMOTE PC PRIVILEGED HELPER"
hash_file /usr/apps/privileged-service/bin/mount.smb.sh

section "PROFILE.D BOOT CARRIER (READ ONLY)"
hash_file /etc/profile.d/bash_prompt_custom.sh

section "ROOT FILESYSTEM MOUNT"
awk '$2=="/" {print "ROOT_MOUNT=" $1 " " $2 " " $3 " " $4}' /proc/mounts 2>/dev/null || true
df -P / 2>/dev/null || true

section "PARTITION INVENTORY (READ ONLY)"
if [ -r /proc/partitions ]; then
    cat /proc/partitions
else
    printf '/proc/partitions unavailable\n'
fi
if [ -r /proc/mtd ]; then
    cat /proc/mtd
else
    printf '/proc/mtd unavailable\n'
fi

section "VETRO SERVICE CONFIGURATION REFERENCE"
printf 'The source manifest should declare on-boot=true and auto-restart=true.\n'
printf 'This preflight does not alter package flags, system services, /etc, or block devices.\n'

section "END"
printf 'No files were created, changed, or deleted by this preflight.\n'
