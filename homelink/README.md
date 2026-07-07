# 🏠 HomeLink Bridge

**One app that links SmartThings and Wipro smart devices to Apple HomeKit — natively.**

HomeLink runs a single HomeKit **bridge** (built on [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS), the engine behind Homebridge). You log in to your platforms once in a friendly web portal, pair the bridge with the Apple Home app by scanning a QR code, and every light, switch, and plug from both ecosystems shows up as a native HomeKit accessory — controllable from the Home app, Siri, Control Center, and HomeKit automations.

```
 SmartThings cloud ──┐
                     ├──► HomeLink (normalizes devices) ──► HomeKit Bridge ──► Apple Home / Siri
 Wipro (Tuya) cloud ─┘
```

## Features

- **Combined setup portal** (`http://localhost:8580`) — connect both accounts, see live device state, pick which devices are exposed.
- **SmartThings**: log in with a Personal Access Token; lights, dimmers, color bulbs, switches, and plugs are auto-discovered.
- **Wipro / Tuya**: Wipro Next Smart Home runs on the Tuya cloud — link your app account to a free Tuya IoT project and HomeLink discovers and controls the devices, including brightness, white temperature, and full color (with correct v1/v2 data-point scaling read from each device's specification).
- **Native HomeKit**: one QR-code pairing; on/off, brightness, color temperature, and hue/saturation all mapped to HomeKit characteristics; state polled and pushed back so the Home app stays in sync with the physical switches and the vendor apps.

## Quick start

```bash
cd homelink
npm install
npm start
```

Then open **http://localhost:8580** and follow the three cards:

### Run it as a server on a Mac

To keep HomeLink running permanently on a MacBook/Mac mini (start at login, auto-restart on crash):

```bash
cd homelink
./scripts/macos-server.sh install     # installs deps + registers a launchd service
./scripts/macos-server.sh status      # portal URL + HomeKit PIN
./scripts/macos-server.sh logs        # tail the app log
```

Notes for Mac servers:

- When macOS asks whether **node** may *accept incoming network connections*, click **Allow** — that's HomeKit traffic from your iPhone/Apple TV.
- The Mac must be on the **same Wi-Fi/LAN** as your Apple devices, and shouldn't go to full sleep: enable *System Settings → Battery/Energy → Prevent automatic sleeping when the display is off* (or run `sudo pmset -a sleep 0` / `caffeinate`), ideally keeping the MacBook on power.
- An **Apple TV or HomePod** on the same network automatically becomes a *home hub*, which gives you control when away from home and enables automations — no extra setup in HomeLink needed.
- The portal is also reachable from your phone at `http://<your-mac-name>.local:8580`.

### 1. Connect SmartThings

1. Go to [account.smartthings.com/tokens](https://account.smartthings.com/tokens) and sign in with your Samsung account.
2. *Generate new token* → name it "HomeLink" → check the **Devices** scopes (list, see, control).
3. Paste the token in the SmartThings card.

> ⚠️ PATs created after Dec 2024 expire after 24 hours. For long-term use, set up a SmartThings OAuth app, or simply paste a fresh token when needed — device pairing with HomeKit is *not* lost when a token expires.

### 2. Connect Wipro (Tuya cloud)

Wipro's "Next Smart Home" app is a rebranded Tuya app, so control goes through Tuya's official OpenAPI:

1. Create a free developer account at [iot.tuya.com](https://iot.tuya.com) → **Cloud → Create Cloud Project**. Pick the data center that matches your app account (**India** for most Wipro users).
2. In the project, subscribe to the (free trial) **IoT Core** and **Authorization Token Management** services.
3. Open **Devices → Link App Account → Add App Account**, and scan the QR code with the Wipro Next Smart Home (or Smart Life) app — *Me → scanner icon*. All devices from your app account appear in the project.
4. Copy the project's **Access ID** and **Access Secret** (Overview tab) into the Wipro/Tuya card and pick your data center.

### 3. Pair with Apple Home

Open the **Home** app on your iPhone/iPad → **+ → Add Accessory** → scan the QR code shown in the portal (or choose *More options…* and enter the setup PIN). Done — all connected devices appear in one step, and new devices are added automatically as you connect platforms.

> HomeKit pairing uses mDNS/Bonjour, so run HomeLink on a machine (Raspberry Pi, Mac, home server, always-on PC) that's on the **same network** as your iPhone.

## What gets exposed

| Source capability | HomeKit |
|---|---|
| SmartThings `switch` / Tuya `switch_led`, `switch`, `switch_1` | On/Off |
| SmartThings `switchLevel` / Tuya `bright_value(_v2)` | Brightness |
| SmartThings `colorTemperature` / Tuya `temp_value(_v2)` | Color Temperature |
| SmartThings `colorControl` / Tuya `colour_data(_v2)` | Hue + Saturation |

Device types are inferred (light / outlet / switch) from capabilities and categories. Sensors and other read-only devices are not exposed yet (see Roadmap).

## Configuration & data

Everything lives in `./data` (override with `HOMELINK_DATA_DIR`):

- `config.json` — platform credentials, bridge identity (MAC/PIN are generated once and persisted), excluded devices.
- `persist/` — HomeKit pairing state (managed by HAP-NodeJS). Delete this only if you want to force re-pairing.

Environment variables: `HOMELINK_WEB_PORT` (default `8580`), `HOMELINK_DATA_DIR`.

## Architecture

```
src/
  index.js               entry point — wires config, app core, web portal
  config.js              config persistence + bridge identity generation
  app.js                 app core: platform registry, device inventory, sync
  bridge.js              HAP-NodeJS bridge; characteristic wiring, polling,
                         write batching (Home app sends hue/sat/brightness
                         as separate events — batched into one cloud call)
  platforms/
    smartthings.js       SmartThings REST adapter (PAT bearer auth)
    tuya.js              Tuya OpenAPI adapter (HMAC-SHA256 signing v2.0),
                         device-spec-aware value scaling for Wipro devices
  web/
    server.js            Express JSON API
    public/              setup portal (vanilla HTML/CSS/JS, dark-mode aware)
test/                    unit tests (node --test) with mocked cloud APIs
```

Both platform adapters normalize to one device/state model (`power`, `brightness` 0–100, `colorTempK`, `hue` 0–360, `saturation` 0–100), so adding another ecosystem (Philips Hue, Govee, …) is a single new adapter file.

## Tests

```bash
npm test
```

Covers Tuya request signing, Wipro/Tuya value scaling (10–1000 brightness, HSV color, work modes), SmartThings device normalization, and the 0–100 ↔ 0–360 hue conversions.

## Roadmap

- Sensors (contact/motion/temperature) as HomeKit read-only accessories
- SmartThings OAuth flow (no more 24h token refresh)
- Tuya Pulsar/webhook push events instead of polling
- More device classes: covers, thermostats, fans
