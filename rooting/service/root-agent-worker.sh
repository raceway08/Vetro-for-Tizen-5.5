# This source is passed to /bin/sh -c by the signed archive launch script.
# It owns command execution for the Node 4.4 agent; Node never calls spawn().
D="$1"
TAB=$(printf '\t')

exec 3<> "$D/commands" || exit 1
exec 4<> "$D/results" || exit 1
exec 5<> "$D/stdout" || exit 1
exec 6<> "$D/stderr" || exit 1

printf 'READY\n' >&4

while IFS= read -r line <&3; do
    if [ "$line" = "QUIT" ]; then
        break
    fi

    case "$line" in
        EXEC"$TAB"*) ;;
        *) continue ;;
    esac

    rest=${line#EXEC"$TAB"}
    sequence=${rest%%"$TAB"*}
    timeout=${rest#*"$TAB"}

    case "$sequence" in
        ''|*[!0-9]*)
            continue
            ;;
    esac
    case "$timeout" in
        ''|*[!0-9]*)
            printf 'ERROR\t%s\n' "$sequence" >&4
            continue
            ;;
    esac

    command_file="$D/cmd-$sequence"
    if [ ! -f "$command_file" ]; then
        printf 'ERROR\t%s\n' "$sequence" >&4
        continue
    fi

    command_text=$(/bin/cat "$command_file")
    rm -f "$command_file"

    # setsid gives each user command its own process group, so timeout can
    # terminate the complete command tree without terminating this worker.
    /usr/bin/setsid /bin/sh -c "$command_text" >&5 2>&6 &
    child=$!

    ticks=$(( (timeout + 99) / 100 ))
    elapsed=0
    timed_out=0

    while :; do
        child_state=$(ps -p "$child" -o stat= 2>/dev/null)
        case "$child_state" in
            ''|Z*|z*) break ;;
        esac

        if [ "$elapsed" -ge "$ticks" ]; then
            timed_out=1
            kill -KILL -- "-$child" 2>/dev/null || kill -KILL "$child" 2>/dev/null
            break
        fi

        /usr/bin/sleep 0.1
        elapsed=$((elapsed + 1))
    done

    wait "$child"
    exit_code=$?
    if [ "$timed_out" -eq 1 ]; then
        exit_code=124
    fi

    printf 'RESULT\t%s\t%s\t%s\n' \
        "$sequence" "$exit_code" "$timed_out" >&4
done

printf 'STOPPED\n' >&4
exec 6>&-
exec 5>&-
exec 4>&-
exec 3<&-
