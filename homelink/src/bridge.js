/**
 * HomeKit bridge built on HAP-NodeJS.
 *
 * Publishes a single Bridge accessory; every SmartThings / Wipro (Tuya)
 * device is attached behind it as a bridged accessory, so pairing the bridge
 * once in the Apple Home app brings in all devices natively.
 */

import {
  Accessory,
  Bridge,
  Categories,
  Characteristic,
  Service,
  uuid,
} from '@homebridge/hap-nodejs';

const POLL_INTERVAL_MS = 10_000;

// SmartThings AC modes ↔ HomeKit TargetHeaterCoolerState (AUTO=0, HEAT=1, COOL=2).
// Dry/wind/fan have no HomeKit equivalent and are surfaced as COOL.
const AC_MODE_TO_HK = { auto: 0, heat: 1, cool: 2, dry: 2, wind: 2, fan: 2, fanOnly: 2 };
const HK_TO_AC_MODE = { 0: 'auto', 1: 'heat', 2: 'cool' };

export class HomeKitBridge {
  constructor(config) {
    this.config = config;
    this.bridge = new Bridge(config.bridge.name, uuid.generate('homelink.bridge'));
    this.accessories = new Map(); // key -> { accessory, device, platform, state }
    this.published = false;
    this.pollTimer = null;

    const info = this.bridge.getService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'HomeLink')
      .setCharacteristic(Characteristic.Model, 'HomeLink Bridge')
      .setCharacteristic(Characteristic.SerialNumber, config.bridge.username)
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');
  }

  static deviceKey(device) {
    return `${device.platform}:${device.id}`;
  }

  async publish() {
    if (this.published) return;
    await this.bridge.publish({
      username: this.config.bridge.username,
      pincode: this.config.bridge.pincode,
      port: this.config.bridge.port,
      category: Categories.BRIDGE,
      addIdentifyingMaterial: true,
    });
    this.published = true;
    this.pollTimer = setInterval(() => {
      this.refreshStates().catch((err) => console.error('[homelink] poll error:', err.message));
    }, POLL_INTERVAL_MS);
    console.log(`[homelink] HomeKit bridge published — pin ${this.config.bridge.pincode}`);
  }

  setupURI() {
    return this.bridge.setupURI();
  }

  isPaired() {
    return this.bridge._accessoryInfo?.paired() ?? false;
  }

  /**
   * Reconciles the set of bridged accessories with the given device list.
   * Safe to call repeatedly (initial sync, re-login, exclusion changes).
   */
  syncDevices(entries /* [{ device, platform }] */) {
    const excluded = new Set(this.config.excludedDevices ?? []);
    const wanted = new Map();
    for (const entry of entries) {
      const key = HomeKitBridge.deviceKey(entry.device);
      if (!excluded.has(key)) wanted.set(key, entry);
    }

    for (const [key, record] of this.accessories) {
      if (!wanted.has(key)) {
        this.bridge.removeBridgedAccessory(record.accessory);
        this.accessories.delete(key);
        console.log(`[homelink] removed accessory ${record.device.name}`);
      }
    }

    for (const [key, entry] of wanted) {
      const existing = this.accessories.get(key);
      if (existing) {
        existing.device = entry.device; // refresh name/model/feature mapping
        continue;
      }
      const record = this.#createAccessory(key, entry.device, entry.platform);
      this.accessories.set(key, record);
      this.bridge.addBridgedAccessory(record.accessory);
      console.log(`[homelink] added ${entry.device.type} "${entry.device.name}" (${entry.platform.label})`);
    }
  }

  #createAccessory(key, device, platform) {
    const accessory = new Accessory(device.name, uuid.generate(`homelink:${key}`));
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, platform.label)
      .setCharacteristic(Characteristic.Model, device.model || 'Unknown')
      .setCharacteristic(Characteristic.SerialNumber, device.id.slice(0, 24));

    const record = { accessory, device, platform, state: {}, pending: null };

    if (device.type === 'ac') {
      record.service = this.#createAcService(accessory, record, device);
      return record;
    }

    const ServiceType =
      device.type === 'light' ? Service.Lightbulb : device.type === 'outlet' ? Service.Outlet : Service.Switch;
    const service = accessory.addService(ServiceType, device.name);
    record.service = service;

    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => record.state.power ?? false)
      .onSet((value) => this.#apply(record, { power: !!value }));

    if (device.type === 'light' && device.features.brightness) {
      service
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => record.state.brightness ?? 100)
        .onSet((value) => this.#apply(record, { brightness: Number(value) }));
    }

    if (device.type === 'light' && device.features.colorTemp) {
      const { minK, maxK } = device.features.colorTemp;
      service
        .getCharacteristic(Characteristic.ColorTemperature)
        .setProps({ minValue: Math.floor(1e6 / maxK), maxValue: Math.ceil(1e6 / minK) })
        .onGet(() => Math.round(1e6 / (record.state.colorTempK || 2700)))
        .onSet((mireds) => this.#apply(record, { colorTempK: Math.round(1e6 / Number(mireds)) }));
    }

    if (device.type === 'light' && device.features.color) {
      service
        .getCharacteristic(Characteristic.Hue)
        .onGet(() => record.state.hue ?? 0)
        .onSet((value) => this.#apply(record, { hue: Number(value) }));
      service
        .getCharacteristic(Characteristic.Saturation)
        .onGet(() => record.state.saturation ?? 0)
        .onSet((value) => this.#apply(record, { saturation: Number(value) }));
    }

    return record;
  }

  /** Air conditioners map to HomeKit's HeaterCooler service. */
  #createAcService(accessory, record, device) {
    const service = accessory.addService(Service.HeaterCooler, device.name);
    const ac = device.features.ac;

    const validTargets = [...new Set(
      ac.modes.map((m) => AC_MODE_TO_HK[m]).filter((v) => v !== undefined)
    )].sort();
    if (!validTargets.length) validTargets.push(2);

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (record.state.power ? 1 : 0))
      .onSet((value) => this.#apply(record, { power: value === 1 }));

    service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.#currentAcState(record.state));

    service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: validTargets })
      .onGet(() => AC_MODE_TO_HK[record.state.mode] ?? validTargets[validTargets.length - 1])
      .onSet((value) => this.#apply(record, { mode: HK_TO_AC_MODE[value] }));

    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => record.state.currentC ?? 24);

    const setpointProps = { minValue: ac.minC, maxValue: ac.maxC, minStep: 0.5 };
    service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps(setpointProps)
      .onGet(() => this.#clampSetpoint(record.state.targetC, ac))
      .onSet((value) => this.#apply(record, { targetC: Number(value) }));

    if (validTargets.includes(0) || validTargets.includes(1)) {
      // Home app shows a heating threshold in auto/heat modes; ACs have one
      // setpoint, so both thresholds drive the same value.
      service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps(setpointProps)
        .onGet(() => this.#clampSetpoint(record.state.targetC, ac))
        .onSet((value) => this.#apply(record, { targetC: Number(value) }));
    }
    return service;
  }

  #clampSetpoint(value, ac) {
    return Math.max(ac.minC, Math.min(ac.maxC, value ?? Math.round((ac.minC + ac.maxC) / 2)));
  }

  // INACTIVE=0, IDLE=1, HEATING=2, COOLING=3 — inferred from mode + temps
  #currentAcState(state) {
    if (!state.power) return 0;
    const current = state.currentC;
    const target = state.targetC;
    if (current === undefined || target === undefined) return 1;
    const mode = state.mode;
    if (mode === 'heat') return current < target ? 2 : 1;
    if (mode === 'auto') return current > target ? 3 : current < target ? 2 : 1;
    return current > target ? 3 : 1; // cool / dry / wind
  }

  /**
   * Batches rapid characteristic writes (Home app sends Hue + Saturation +
   * Brightness as separate events) into one platform call.
   */
  #apply(record, changes) {
    Object.assign(record.state, changes);
    if (record.pending) {
      Object.assign(record.pending.changes, changes);
      return;
    }
    record.pending = { changes: { ...changes } };
    setTimeout(async () => {
      const { changes: batched } = record.pending;
      record.pending = null;
      if ((batched.hue !== undefined || batched.saturation !== undefined) && batched.brightness === undefined) {
        batched._currentBrightness = record.state.brightness;
      }
      try {
        await record.platform.setState(record.device.id, batched, record.device);
      } catch (err) {
        console.error(`[homelink] failed to control "${record.device.name}":`, err.message);
      }
    }, 75);
  }

  /** Current cached state for a bridged device (used by the web remote). */
  getState(key) {
    return this.accessories.get(key)?.state ?? null;
  }

  /**
   * Reflects an externally-initiated change (e.g. the web remote) into the
   * cached state and HomeKit characteristics, so the Home app updates too.
   * No-op for excluded devices (no bridged accessory).
   */
  reflectExternalChange(key, changes) {
    const record = this.accessories.get(key);
    if (!record) return;
    Object.assign(record.state, changes);
    this.#pushState(record);
  }

  async refreshStates() {
    const records = [...this.accessories.values()];
    await Promise.allSettled(
      records.map(async (record) => {
        if (record.pending) return; // don't fight in-flight writes
        const state = await record.platform.getState(record.device.id, record.device);
        record.state = { ...record.state, ...state };
        this.#pushState(record);
      })
    );
  }

  #pushState(record) {
    const { service, state, device } = record;
    if (device.type === 'ac') {
      if (state.power !== undefined) service.updateCharacteristic(Characteristic.Active, state.power ? 1 : 0);
      service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, this.#currentAcState(state));
      if (state.mode !== undefined && AC_MODE_TO_HK[state.mode] !== undefined) {
        service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, AC_MODE_TO_HK[state.mode]);
      }
      if (state.currentC !== undefined) service.updateCharacteristic(Characteristic.CurrentTemperature, state.currentC);
      if (state.targetC !== undefined) {
        const clamped = this.#clampSetpoint(state.targetC, device.features.ac);
        service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, clamped);
        if (service.testCharacteristic(Characteristic.HeatingThresholdTemperature)) {
          service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, clamped);
        }
      }
      return;
    }
    if (state.power !== undefined) service.updateCharacteristic(Characteristic.On, state.power);
    if (device.type !== 'light') return;
    if (device.features.brightness && state.brightness !== undefined) {
      service.updateCharacteristic(Characteristic.Brightness, Math.max(0, Math.min(100, state.brightness)));
    }
    if (device.features.colorTemp && state.colorTempK) {
      const char = service.getCharacteristic(Characteristic.ColorTemperature);
      const mireds = Math.max(char.props.minValue, Math.min(char.props.maxValue, Math.round(1e6 / state.colorTempK)));
      service.updateCharacteristic(Characteristic.ColorTemperature, mireds);
    }
    if (device.features.color) {
      if (state.hue !== undefined) service.updateCharacteristic(Characteristic.Hue, Math.max(0, Math.min(360, state.hue)));
      if (state.saturation !== undefined) {
        service.updateCharacteristic(Characteristic.Saturation, Math.max(0, Math.min(100, state.saturation)));
      }
    }
  }

  listBridged() {
    return [...this.accessories.entries()].map(([key, r]) => ({
      key,
      platform: r.platform.name,
      platformLabel: r.platform.label,
      name: r.device.name,
      model: r.device.model,
      type: r.device.type,
      online: r.device.online,
      features: {
        power: r.device.features.power,
        brightness: r.device.features.brightness,
        colorTemp: !!r.device.features.colorTemp,
        color: r.device.features.color,
        ac: !!r.device.features.ac,
      },
      state: {
        power: r.state.power,
        brightness: r.state.brightness,
        colorTempK: r.state.colorTempK,
        hue: r.state.hue,
        saturation: r.state.saturation,
        mode: r.state.mode,
        currentC: r.state.currentC,
        targetC: r.state.targetC,
        panelLight: r.state.panelLight,
        optionalMode: r.state.optionalMode,
        watts: r.state.watts,
        energyKwh: r.state.energyKwh,
      },
    }));
  }

  async unpublish() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.published) await this.bridge.unpublish();
    this.published = false;
  }
}
