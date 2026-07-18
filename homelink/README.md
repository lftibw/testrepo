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
- **Web remote** (`/remote`): a control dashboard in the browser — power, brightness, warmth, color, and full AC controls (mode + temperature). Extras: master actions (**all lights on/off**, **everything off**), device-type **filters**, one-tap **color presets**, and per-device **auto-off timers** (15/30/60 min with a live countdown). A **liquid-glass** UI (frosted translucent cards, gradient background, animated toggles) that adapts to light/dark. **Reactive**: after any action the device's real state is re-read, so side-effects (e.g. Max mode shifting the setpoint) animate back into the UI within a couple of seconds. Any change is sent to the device *and* mirrored into HomeKit, so the web remote and the Home app always agree. Because it talks straight to the device clouds, it works from anywhere you can reach the HomeLink server — no home hub required (unlike Apple's away-from-home access). Reachable from your phone at `http://<your-mac-name>.local:8580/remote`.

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

### 1. Connect SmartThings — two ways

> **Multiple accounts:** you can connect more than one SmartThings account at once (e.g. yours plus a family member's, so their AC shows up in your Home too). Each connection is added and disconnected independently in the SmartThings card, and its devices carry the account label. Use either method below per account — for a second account, sign in with *that* account when the OAuth page opens, or paste a token generated from that account.

#### Method A — Auto-refresh OAuth (recommended, stays connected)

A personal token expires every 24 hours; OAuth uses a **refresh token** that HomeLink renews automatically, so the connection never expires. One-time setup:

1. Install the SmartThings CLI: `npm i -g @smartthings/cli` (or grab a binary from [releases](https://github.com/SmartThingsCommunity/smartthings-cli/releases)).
2. Run `smartthings apps:create` → choose **OAuth-In SmartApp**.
3. Scopes: `r:devices:*`, `x:devices:*`, `r:locations:*`.
4. Redirect URI: the exact value shown in HomeLink's SmartThings card (e.g. `http://localhost:8580/api/smartthings/callback`).
5. The CLI prints an **OAuth Client ID** and **Client Secret** — paste them into HomeLink, click **Authorize with SmartThings**, and approve in the page that opens.

HomeLink stores the refresh token and renews it on every run (access tokens last 24h, the refresh token lasts 30 days and is reissued each refresh), so as long as HomeLink runs at least once a month it stays linked indefinitely.

#### Method B — Quick token (24h, for a fast test)

1. Go to [account.smartthings.com/tokens](https://account.smartthings.com/tokens) and sign in with your Samsung account.
2. *Generate new token* → name it "HomeLink" → check the **Devices** scopes (list, see, control).
3. Paste the token in the SmartThings card's **Quick token** tab.

> ⚠️ PATs created after Dec 2024 expire after 24 hours. HomeKit pairing is *not* lost when a token expires, but you'd have to paste a fresh one daily — use Method A to avoid that.

### 2. Connect Wipro — two ways

Wipro's "Next Smart Home" app is a rebranded Tuya app. HomeLink supports both of Tuya's access paths:

#### Method A — Smart Life app login (recommended, no developer account)

This is the same mechanism Home Assistant's official Tuya integration uses (a port of Tuya's [`tuya-device-sharing-sdk`](https://github.com/tuya/tuya-device-sharing-sdk)): you scan a QR with the **Smart Life** app and you're in. No Tuya console, no cloud project, no data-center guessing.

1. Install the **Smart Life** app and pair your Wipro bulbs in it (they're standard Tuya devices: flick the wall switch off/on 3× until the bulb blinks, then *Add Device*). A bulb can live in only one app at a time, so it moves out of Wipro Next — you'll control it from Apple Home anyway.
2. In Smart Life: **Me → Settings ⚙ → Account and Security → User Code** — enter that code in HomeLink's Wipro card (Smart Life tab).
3. Tap **Get login QR code**, scan it with Smart Life's scanner (*Me → ⊕/scanner icon*), approve. Done.

#### Method B — Tuya developer project (advanced)

1. Create a free developer account at [iot.tuya.com](https://iot.tuya.com) → **Cloud → Create Cloud Project**. Pick the data center that matches your app account. **For Wipro Next this is usually Central Europe**, not India: Tuya homes Indian accounts of pre-Sep-2020 OEM apps (Wipro Next launched in 2018) in the Central Europe DC ([mapping rules](https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed?id=Kafi0ku9l07qb)). If QR linking fails against Central Europe, retry with India — the account-to-DC mapping must match or linking fails even after you approve in the app.
2. In the project, subscribe to the (free trial) **IoT Core** and **Authorization Token Management** services.
3. Open **Devices → Link App Account → Add App Account**, and scan the QR code with the Wipro Next Smart Home (or Smart Life) app — *Me → scanner icon*. All devices from your app account appear in the project.
4. Copy the project's **Access ID** and **Access Secret** (Overview tab) into the Wipro/Tuya card (Developer project tab) and pick your data center. HomeLink handles both classic (iot.tuya.com) and new (platform.tuya.com) project types automatically.

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
| SmartThings `airConditionerMode` + `thermostatCoolingSetpoint` + `temperatureMeasurement` | HeaterCooler: power, mode (auto/heat/cool), target temperature, current temperature |

Air conditioners (e.g. Samsung WindFree units in SmartThings) appear as native HomeKit **HeaterCooler** accessories: on/off, mode selection, and temperature setpoint straight from the Home app or Siri ("set the bedroom AC to 24 degrees"). Supported modes and setpoint limits are read from the device; °F units are converted automatically. Tuya `dry`/`wind` modes have no HomeKit equivalent and surface as *Cool*. If the AC exposes a front-panel/display light (SmartThings `samsungce.airConditionerLighting`), the web remote shows a **Panel light** toggle. If it exposes optional modes (`custom.airConditionerOptionalMode`), the remote shows an **Extra mode** selector — **Max** (turbo/`speed`), WindFree, Sleep, Quiet, etc. — with Normal to switch back. Both are read from the device, so only the controls your AC actually supports appear.

Device types are inferred (light / outlet / switch / ac) from capabilities and categories. Sensors and other read-only devices are not exposed yet (see Roadmap).

## Apple TV / Home app checklist

You **pair once from an iPhone or iPad** — the Apple TV cannot scan the pairing QR itself. After that, accessories appear on every device signed into the same iCloud Home, including the Apple TV, automatically:

1. Pair via iPhone Home app → **+ → Add Accessory** → scan HomeLink's QR.
2. The Apple TV must be **signed into the same Apple ID / iCloud account** (or added as a member of the same Home via invitation) and have **Settings → AirPlay & HomeKit / Users → iCloud → Home** enabled.
3. If the Apple TV shows a different or empty home, open the Home app on tvOS and check the selected home (long-press the Home icon / top-left home switcher).
4. The Apple TV then also acts as the **home hub** (visible in the iPhone Home app → ⋯ → Home Settings → Home Hubs & Bridges), enabling remote access and automations.
5. Nothing shows anywhere? The pairing itself failed: make sure the Mac and iPhone are on the same Wi-Fi (no guest network / AP isolation), macOS Firewall allowed **node** to accept incoming connections, and HomeLink's portal says "Paired with Apple Home".

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
