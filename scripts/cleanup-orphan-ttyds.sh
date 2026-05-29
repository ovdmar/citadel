#!/usr/bin/env bash
# Reap ttyd processes that no citadel daemon owns.
#
# WHY this exists: ttyds are spawned `detached: true` with KillMode=process
# on citadel.service so they survive daemon restarts (the cockpit's WS
# auto-reconnect lands on the same ttyd post-restart). The daemon adopts
# them back on boot via discoverExistingTtyds() + ttyd.adopt(), but two
# generations of bug left orphans behind:
#   1) Before ttyd-slot.ts shipped (2026-05-27), ttyds bound in the 7000s.
#      The slot scheme then moved the systemd daemon to ports 11000–11999.
#      Discovery used to filter by port range, so the pre-existing 7xxx
#      ttyds became invisible. They still listen, still hold tmux clients,
#      and are unreachable from the cockpit. The discovery filter is gone
#      now — but anything started before that fix needs a manual sweep.
#   2) Before reviveProxyTarget was single-flighted, two concurrent
#      revive paths (HTTP + WS upgrade) could each spawn a ttyd for the
#      same session. The map kept one; the rest piled up.
#
# CONTRACT: a ttyd is "owned" iff every running citadel daemon's
# /api/terminals lists its key at its current port. Everything else is
# fair game to SIGTERM.
#
# Safe to re-run. Talks to every daemon it can find by walking
# /home/*/Workspace*/.citadel/dev.json + the systemd port (4010). Falls
# back to the citadel.sqlite agent_sessions list when a daemon is
# unreachable (best-effort — keys present in the DB are spared even if no
# daemon is currently serving them).
#
# Dry-run by default. Pass --apply to actually SIGTERM.

set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }

# --- Collect owned (pid, port, key) triples from every reachable daemon. ---

declare -A OWNED_PID_PORT  # key=pid → "port|key"
declare -A OWNED_KEYS      # key=session_id → 1

collect_from_daemon() {
  local url="$1"
  local payload
  payload=$(curl -fsS --max-time 2 "$url/api/terminals" 2>/dev/null || true)
  if [[ -z "$payload" ]]; then
    return 1
  fi
  while IFS=$'\t' read -r key port; do
    [[ -z "$key" ]] && continue
    OWNED_KEYS["$key"]=1
    if [[ -n "$port" ]]; then
      # Find the pid that owns this port (we don't trust the daemon to
      # send us a pid). ss is lighter than lsof.
      local pid
      pid=$(ss -tlnp 2>/dev/null | awk -v p=":$port " '$0 ~ p {
        match($0, /pid=[0-9]+/); if (RSTART) print substr($0, RSTART+4, RLENGTH-4); exit }')
      [[ -n "$pid" ]] && OWNED_PID_PORT["$pid"]="$port|$key"
    fi
  done <<<"$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
  doc = json.load(sys.stdin)
except Exception:
  sys.exit(0)
for t in doc.get("terminals", []):
  print("{key}\t{port}".format(key=t.get("key",""), port=t.get("port","")))
')"
  return 0
}

reached=0
for dev_state in /home/*/Workspace*/.citadel/dev.json; do
  [[ -e "$dev_state" ]] || continue
  port=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("port",""))' "$dev_state" 2>/dev/null || true)
  [[ -z "$port" ]] && continue
  if collect_from_daemon "http://127.0.0.1:$port"; then
    log "reached daemon at :$port via $(dirname "$dev_state")"
    reached=$((reached + 1))
  fi
done

# Systemd long-term daemon — port 4010 unless overridden in citadel.service.
if collect_from_daemon "http://127.0.0.1:4010"; then
  log "reached daemon at :4010 (systemd)"
  reached=$((reached + 1))
fi

if [[ $reached -eq 0 ]]; then
  log "no daemons reachable — falling back to DB-only key allow-list"
fi

# Always merge the DB key set as a safety net: if a daemon was momentarily
# down, its sessions are still in the DB and we don't want to nuke their
# ttyds just because /api/terminals was unreachable for this one call.
for db in /home/*/.local/share/citadel/citadel.sqlite; do
  [[ -e "$db" ]] || continue
  while read -r key; do
    [[ -z "$key" ]] && continue
    OWNED_KEYS["$key"]=1
  done < <(sqlite3 "$db" "SELECT id FROM agent_sessions" 2>/dev/null || true)
done

log "owned keys: ${#OWNED_KEYS[@]}  owned pid/port pairs: ${#OWNED_PID_PORT[@]}"

# --- Walk every listening ttyd; SIGTERM the ones nobody owns. ---

kept=0
victims=()

while read -r line; do
  [[ "$line" != *ttyd* ]] && continue
  port=$(awk '{print $4}' <<<"$line" | awk -F: '{print $NF}')
  pid=$(awk '{
    match($0, /pid=[0-9]+/); if (RSTART) print substr($0, RSTART+4, RLENGTH-4) }' <<<"$line")
  [[ -z "$pid" || -z "$port" ]] && continue
  # Extract key from /proc/$pid/cmdline -b argument.
  key=$(tr '\0' '\n' </proc/"$pid"/cmdline 2>/dev/null \
        | awk 'BEGIN{want=0} { if (want) { print; exit } if ($0=="-b") want=1 }' \
        | awk -F/ '{print $NF}')
  [[ -z "$key" ]] && key="(no -b arg)"
  owner="${OWNED_PID_PORT[$pid]:-}"
  if [[ -n "$owner" ]]; then
    kept=$((kept + 1))
    continue
  fi
  # Pid/port not directly owned. If the KEY is in the owner set (different
  # daemon serving it via a different ttyd, e.g. a duplicate that the
  # current daemon spawned during the race) — still reap, the daemon has
  # already picked a winner and the cockpit only talks to that one.
  if [[ -n "${OWNED_KEYS[$key]:-}" ]]; then
    # Surplus duplicate: same key, different pid. Reap.
    victims+=("$pid|$port|$key|duplicate")
  else
    victims+=("$pid|$port|$key|orphan")
  fi
done < <(ss -tlnp 2>/dev/null)

log "ttyds kept: $kept  victims: ${#victims[@]}"
for v in "${victims[@]}"; do
  IFS='|' read -r pid port key reason <<<"$v"
  if [[ "$APPLY" == "1" ]]; then
    kill -TERM "$pid" 2>/dev/null && log "SIGTERM pid=$pid port=$port key=$key ($reason)" \
                                  || log "could not signal pid=$pid (already gone?)"
  else
    log "[dry] would SIGTERM pid=$pid port=$port key=$key ($reason)"
  fi
done

if [[ "$APPLY" != "1" && ${#victims[@]} -gt 0 ]]; then
  log ""
  log "Re-run with --apply to actually reap."
fi
