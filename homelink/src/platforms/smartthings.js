/**
 * SmartThings platform adapter.
 *
 * Talks to the SmartThings public REST API (https://api.smartthings.com/v1)
 * using a Personal Access Token (https://account.smartthings.com/tokens)
 * or an OAuth2 bearer token.
 *
 * Normalized device shape shared by all platforms:
 *   { id, platform, name, model, online, type: 'light'|'switch'|'outlet',
 *     features: { power, brightness, colorTemp: {minK, maxK}|null, color } }
 *
 * Normalized state shape:
 *   { power: bool, brightness: 0-100, colorTempK: number,
 *     hue: 0-360, saturation: 0-100 }
 */

const API_BASE = 'https://api.smartthings.com/v1';

// SmartThings device categories that we expose as HomeKit outlets/switches
const OUTLET_CATEGORIES = new Set(['SmartPlug', 'Outlet']);
const LIGHT_CATEGORIES = new Set(['Light', 'Bulb', 'LightStrip', 'Lamp']);

export class SmartThingsPlatform {
  name = 'smartthings';
  label = 'SmartThings';

  constructor({ token }) {
    this.token = token;
  }

  async #request(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SmartThings API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  /** Verifies credentials; returns basic account info. Throws on bad token. */
  async testConnection() {
    const data = await this.#request('/devices?max=1');
    return { ok: true, sample: data.items?.length ?? 0 };
  }

  async listDevices() {
    const devices = [];
    let page = await this.#request('/devices?max=200');
    while (true) {
      for (const item of page.items ?? []) devices.push(item);
      const next = page._links?.next?.href;
      if (!next) break;
      const url = new URL(next);
      page = await this.#request(url.pathname.replace(/^\/v1/, '') + url.search);
    }
    return devices.map((d) => this.#normalize(d)).filter(Boolean);
  }

  #capabilities(device) {
    const main = (device.components ?? []).find((c) => c.id === 'main') ?? device.components?.[0];
    return new Set((main?.capabilities ?? []).map((c) => c.id));
  }

  #normalize(device) {
    const caps = this.#capabilities(device);
    if (!caps.has('switch')) return null; // only actuators for now

    const category = device.components?.[0]?.categories?.[0]?.name ?? '';
    let type = 'switch';
    if (caps.has('switchLevel') || caps.has('colorControl') || caps.has('colorTemperature') || LIGHT_CATEGORIES.has(category)) {
      type = 'light';
    } else if (OUTLET_CATEGORIES.has(category)) {
      type = 'outlet';
    }

    return {
      id: device.deviceId,
      platform: this.name,
      name: device.label || device.name || 'SmartThings Device',
      model: device.deviceTypeName || device.name || 'SmartThings',
      online: true, // refined by health check during polling if needed
      type,
      features: {
        power: true,
        brightness: caps.has('switchLevel'),
        colorTemp: caps.has('colorTemperature') ? { minK: 2200, maxK: 6500 } : null,
        color: caps.has('colorControl'),
      },
    };
  }

  async getState(deviceId) {
    const status = await this.#request(`/devices/${deviceId}/status`);
    const main = status.components?.main ?? {};
    const state = {};
    if (main.switch?.switch) state.power = main.switch.switch.value === 'on';
    if (main.switchLevel?.level) state.brightness = Number(main.switchLevel.level.value) || 0;
    if (main.colorTemperature?.colorTemperature) {
      state.colorTempK = Number(main.colorTemperature.colorTemperature.value) || 2700;
    }
    if (main.colorControl?.hue) {
      // SmartThings hue/saturation are 0-100; HomeKit hue is 0-360
      state.hue = (Number(main.colorControl.hue.value) || 0) * 3.6;
      state.saturation = Number(main.colorControl.saturation?.value) || 0;
    }
    return state;
  }

  async setState(deviceId, changes) {
    const commands = [];
    if (changes.power !== undefined) {
      commands.push({ component: 'main', capability: 'switch', command: changes.power ? 'on' : 'off', arguments: [] });
    }
    if (changes.brightness !== undefined) {
      commands.push({ component: 'main', capability: 'switchLevel', command: 'setLevel', arguments: [Math.round(changes.brightness)] });
    }
    if (changes.colorTempK !== undefined) {
      commands.push({ component: 'main', capability: 'colorTemperature', command: 'setColorTemperature', arguments: [Math.round(changes.colorTempK)] });
    }
    if (changes.hue !== undefined || changes.saturation !== undefined) {
      commands.push({
        component: 'main',
        capability: 'colorControl',
        command: 'setColor',
        arguments: [{
          hue: Math.max(0, Math.min(100, (changes.hue ?? 0) / 3.6)),
          saturation: Math.max(0, Math.min(100, changes.saturation ?? 100)),
        }],
      });
    }
    if (!commands.length) return;
    await this.#request(`/devices/${deviceId}/commands`, {
      method: 'POST',
      body: JSON.stringify({ commands }),
    });
  }
}
