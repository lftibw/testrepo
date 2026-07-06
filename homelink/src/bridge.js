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
      },
      state: {
        power: r.state.power,
        brightness: r.state.brightness,
        colorTempK: r.state.colorTempK,
        hue: r.state.hue,
        saturation: r.state.saturation,
      },
    }));
  }

  async unpublish() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.published) await this.bridge.unpublish();
    this.published = false;
  }
}
