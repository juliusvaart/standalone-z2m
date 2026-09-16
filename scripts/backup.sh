#!/usr/bin/env bash
# Snapshot everything that cannot be rebuilt from this repository:
#
#   zigbee2mqtt/data   Zigbee network key, coordinator backup, device database (minus logs)
#   config/            switchboard rules
#   mosquitto/config   broker configuration
#   .env               credentials, Home Assistant token, serial port
#
# Zigbee2MQTT writes its database continuously and flushes coordinator_backup.json
# on shutdown, so it is stopped for the duration of the copy and started again
# afterwards - also when the copy fails.
#
# Mosquitto's persistence volume is deliberately left out: it holds retained
# messages and queued sessions, which Zigbee2MQTT republishes on the next start.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-$root/backups}"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$out_dir/z2m-backup-$stamp.zip"

command -v zip >/dev/null || { echo "zip is not installed: sudo apt install zip" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }

cd "$root"
mkdir -p "$out_dir"

# Only restart what was running before, so a backup on a stopped stack leaves it stopped.
was_running=""
if docker compose ps --services --status running 2>/dev/null | grep -qx zigbee2mqtt; then
  was_running=1
fi

restore_service() {
  [ -n "$was_running" ] || return 0
  echo "[backup] starting zigbee2mqtt"
  docker compose start zigbee2mqtt >/dev/null
}

if [ -n "$was_running" ]; then
  echo "[backup] stopping zigbee2mqtt"
  docker compose stop zigbee2mqtt >/dev/null
  trap restore_service EXIT
fi

sources=()
for path in zigbee2mqtt/data config mosquitto/config .env; do
  if [ -e "$path" ]; then
    sources+=("$path")
  else
    echo "[backup] skipping $path, not present"
  fi
done

[ "${#sources[@]}" -gt 0 ] || { echo "[backup] nothing to archive" >&2; exit 1; }

# The Zigbee network key lives here; without it a restored coordinator cannot rejoin
# the existing devices, so a backup missing it is worth a warning.
[ -f zigbee2mqtt/data/coordinator_backup.json ] ||
  echo "[backup] warning: zigbee2mqtt/data/coordinator_backup.json is missing"

# Zigbee2MQTT's rotated logs are large and worthless in a restore.
zip -qry "$archive" "${sources[@]}" -x 'zigbee2mqtt/data/log/*'
# The archive carries .env and the network key in the clear.
chmod 600 "$archive"

echo "[backup] wrote $archive ($(du -h "$archive" | cut -f1))"
echo "[backup] restore: stop the stack, unzip -o '$archive' into $root, then docker compose up -d"
