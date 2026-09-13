#!/bin/sh
set -eu

: "${MQTT_USERNAME:?MQTT_USERNAME must be set in .env}"
: "${MQTT_PASSWORD:?MQTT_PASSWORD must be set in .env}"

PASSWD_FILE=/mosquitto/data/passwd

# Rebuilt on every start so the broker always matches what the other services use.
# mosquitto_passwd -c refuses to overwrite, so the old file goes first.
rm -f "$PASSWD_FILE"
mosquitto_passwd -b -c "$PASSWD_FILE" "$MQTT_USERNAME" "$MQTT_PASSWORD"
# mosquitto drops privileges to its own user, so the file has to belong to it.
chown mosquitto:mosquitto "$PASSWD_FILE" 2>/dev/null || true
chmod 600 "$PASSWD_FILE"

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
