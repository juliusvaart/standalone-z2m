# Standalone Zigbee2MQTT with Switchboard

Docker Compose stack that runs Zigbee2MQTT, an MQTT broker, and **Switchboard** — a small service
that binds battery switches to Zigbee2MQTT groups, single lights, or Home Assistant entities. It
takes over the job a Hue Bridge would do, for Friends of Hue (Zigbee Green Power), Hue, and any
other Zigbee switch that reports an `action`. A portal on port 80 links to both web interfaces.

```
http://<host>/           portal with two entry points
http://<host>/switches/  switch binding UI (switchboard)
http://<host>/z2m/       Zigbee2MQTT frontend
mqtt://<host>:1883       Mosquitto, for Home Assistant
```

## Services

| Service | Role |
| --- | --- |
| `mosquitto` | MQTT broker, the only component that is exposed on 1883 |
| `zigbee2mqtt` | Zigbee coordinator bridge, frontend on internal port 8080 under `/z2m` |
| `switchboard` | Rule engine + switch binding UI, internal port 3000 |
| `portal` | Caddy on port 80: landing page and reverse proxy for the two UIs |

## Hardware

Runs on a Raspberry Pi. All four images publish `arm/v6`, `arm/v7`, and `arm64` builds, so the
architecture is never the limit — RAM, CPU, and storage are.

| Board | Verdict |
| --- | --- |
| Pi 4 / Pi 5, 2 GB | Recommended |
| Pi 3B / 3B+, 1 GB | Sensible minimum, ~600 MB free after the stack |
| Pi Zero 2 W, 512 MB | Hard floor, with the caveats below |
| Pi 2 (ARMv7, 32-bit) | Works but slow; only worth it if you already own one |
| Pi 1 / Zero / Zero W (ARMv6) | No. Node 22 has no usable ARMv6 build |

Idle memory, measured on arm64:

| Service | RAM |
| --- | --- |
| `mosquitto` | 2.5 MB |
| `switchboard` | 27 MB |
| `portal` | 30 MB |
| `zigbee2mqtt` | 150-250 MB (estimate, grows with network size) |

That is roughly 200-300 MB for the stack, plus the Docker daemon (50-80 MB) and Raspberry Pi OS
Lite headless (100-150 MB). Images take about 610 MB of disk.

On a 512 MB board: add swap and build the `switchboard` image on another machine, because
`npm install` will thrash. The coordinator needs a micro-USB OTG adapter on a Zero 2 W.

Two things that bite regardless of board:

* **Storage.** Zigbee2MQTT's database and Mosquitto's persistence do constant small writes. Boot
  from an SSD, or use a decent A2 card and expect to replace it.
* **2.4 GHz interference.** Onboard Wi-Fi sits on top of the Zigbee band. Prefer ethernet, and put
  the coordinator on a USB extension cable away from the board and from any USB 3 port.

Running Home Assistant on the same Pi changes the answer: 4 GB, Pi 4 or 5. Home Assistant alone
wants 1-2 GB.

## Setup

1. Copy the environment file and set the coordinator:

   ```bash
   cp .env.example .env
   ```

   * Linux with a USB stick: set `Z2M_SERIAL_PORT` to the coordinator's stable device path.
     Prefer the by-id form, which survives reboots and replugging:

     ```bash
     ls -l /dev/serial/by-id/
     # Z2M_SERIAL_PORT=/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_<serial>-if00-port0
     ```

     `/dev/ttyACM0` also works but can move to `ttyACM1` if another serial device enumerates
     first. Compose passes this exact path into the container, so it must exist on the host
     before `docker compose up` - if `ls` prints nothing, the dongle is not enumerating and
     no config change will help.
   * macOS or Windows (Docker Desktop): USB passthrough is not available, so the stack will not
     start with a USB coordinator. Use a network coordinator and set
     `Z2M_SERIAL_PORT=tcp://192.168.1.50:6638`, or comment out the `devices:` block in
     `docker-compose.yml`.

2. Set `MQTT_USERNAME` and `MQTT_PASSWORD` in `.env`. The broker rejects anonymous clients, and
   Compose refuses to start without them.

3. Start the stack:

   ```bash
   docker compose up -d
   ```

4. Open `http://<host>/`, go to Zigbee2MQTT, enable "Permit join", and pair your switches and lights.
   Groups you create in Zigbee2MQTT show up as targets in the switch UI automatically.

5. Point Home Assistant's MQTT integration at `<host>:1883` with those credentials. Zigbee2MQTT discovery is enabled, so
   devices, lights, and groups appear as entities without extra configuration.

## Binding a switch

Open `http://<host>/switches/`:

1. Press a button on the switch. The event shows up under **Recent switch activity**.
2. Click that entry to fill in the switch name and action.
3. Pick a command and a target, then save. **Test** fires the binding without touching the switch.

Bindings are stored in `config/rules.json` and survive restarts.

Typical Friends of Hue actions are `press_1` … `press_4`; Hue dimmer switches report `on_press`,
`up_press_hold`, `up_hold_release`, and similar. Use the hold commands with a `*_hold` action and
`Stop dimming` with the matching `*_release` action.

## Home Assistant and Adaptive Lighting

Each binding targets either a Home Assistant entity or a Zigbee2MQTT name:

* **Home Assistant entity (recommended when Adaptive Lighting is installed).** The bridge calls
  `light.turn_on` / `light.turn_off` / `light.toggle` over the REST API. Adaptive Lighting hooks
  Home Assistant's own turn-on, so the light comes up at the adapted brightness and colour
  temperature. Dimming uses `brightness_step_pct`, which Adaptive Lighting recognises as manual
  control and stops overriding until the light is turned off again — exactly the behaviour its
  `take_over_control` option is built for. Requires `HA_URL` and a long-lived token in `HA_TOKEN`.
  Zigbee2MQTT groups are exposed to Home Assistant as `light.*` entities, so groups work here too.

* **Zigbee2MQTT group or light.** Commands are published to `zigbee2mqtt/<name>/set` directly. This
  works without Home Assistant. The bridge deliberately sends `{"state": "ON"}` with no brightness
  or colour so it never overwrites what Adaptive Lighting last applied. Note that with
  `detect_non_ha_changes` enabled, Adaptive Lighting can still read a direct dim as manual control.

Nothing in this stack writes colour temperature, so it never fights Adaptive Lighting for it.

## When Home Assistant is down

The stack has no runtime dependency on Home Assistant. Mosquitto, Zigbee2MQTT, Switchboard, and the
portal start and run without it, and bindings that target a Zigbee2MQTT group or light are unaffected.

Bindings that target a Home Assistant entity would otherwise stop working, so each one can name a
**fallback** Zigbee2MQTT group or light:

* Switchboard tries Home Assistant first, which keeps Adaptive Lighting in charge.
* If the call fails (connection refused, timeout, or a 5xx), it immediately repeats the command on
  `zigbee2mqtt/<fallback>/set` instead. The light responds; only the adaptive values are missing.
* After a failure, Home Assistant is marked unreachable for 30 seconds, so the next press goes
  straight to Zigbee2MQTT with no timeout delay. A probe every 30 seconds clears that as soon as
  Home Assistant answers again, and the header pill in the UI shows the current state.
* Dim steps are stored as a percentage for Home Assistant targets and scaled to the 0-254 Zigbee
  range for the fallback. Hold and release are tracked per target, so a hold that fell back to
  Zigbee2MQTT is stopped over Zigbee2MQTT too.

Authentication errors (401/403) do not count as an outage — they fail the binding and are logged,
because retrying them on a schedule would hide a broken token.

A binding with no fallback simply logs an error while Home Assistant is unavailable.

## Security

The broker requires authentication: `allow_anonymous false`, with a password file that
`mosquitto/config/entrypoint.sh` regenerates on every start from `MQTT_USERNAME` and
`MQTT_PASSWORD`. Both variables are mandatory — Compose refuses to start without them — and the
same pair is injected into Zigbee2MQTT and Switchboard, so changing the password in `.env` and
running `docker compose up -d` is enough to rotate it everywhere. Use the same credentials in Home
Assistant's MQTT integration.

`.env` holds that password in clear text and is gitignored; keep it that way.

Neither the portal nor the two UIs have authentication, so do not forward port 80 to the internet.

## API

The bridge exposes a small JSON API under `/switches/api/`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | devices, groups, recent actions, connection status |
| `GET` | `/api/ha/lights` | Home Assistant light entities |
| `GET`/`POST` | `/api/rules` | list / create bindings |
| `PUT`/`DELETE` | `/api/rules/:id` | update / remove a binding |
| `POST` | `/api/rules/:id/test` | run a binding once |
