/**
 * SmartThings platform adapter.
 *
 * Talks to the SmartThings public REST API (https://api.smartthings.com/v1)
 * using a Personal Access Token (https://account.smartthings.com/tokens)
 * or an OAuth2 bearer token.
 *
 * Normalized device shape shared by all platforms:
 *   { id, platform, name, model, online, type: 'light'|'switch'|'outlet'|'ac',
 *     features: { power, brightness, colorTemp: {minK, maxK}|null, color,
 *                 ac: { modes: ['auto','cool',...], minC, maxC, unit }|undefined } }
 *
 * Normalized state shape:
 *   { power: bool, brightness: 0-100, colorTempK: number,
 *     hue: 0-360, saturation: 0-100,
 *     mode: SmartThings AC mode string, currentC: °C, targetC: °C }
 */

const toC = (value, unit) => (unit === 'F' ? (Number(value) - 32) * 5 / 9 : Number(value));
const fromC = (c, unit) => (unit === 'F' ? Math.round(c * 9 / 5 + 32) : Math.round(c * 2) / 2);

const API_BASE = 'https://api.smartthings.com/v1';
const OAUTH_AUTHORIZE = 'https://api.smartthings.com/oauth/authorize';
const OAUTH_TOKEN = 'https://api.smartthings.com/oauth/token';

// Scopes needed to list devices and send commands.
export const SMARTTHINGS_SCOPES = ['r:devices:*', 'x:devices:*', 'r:locations:*'];

// SmartThings device categories that we expose as HomeKit outlets/switches
const OUTLET_CATEGORIES = new Set(['SmartPlug', 'Outlet']);
const LIGHT_CATEGORIES = new Set(['Light', 'Bulb', 'LightStrip', 'Lamp']);

/** Authorization-code flow: URL the user visits to grant access. */
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SMARTTHINGS_SCOPES.join(' '),
    response_type: 'code',
    redirect_uri: redirectUri,
  });
  if (state) params.set('state', state);
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

async function tokenRequest(clientId, clientSecret, params) {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`SmartThings OAuth ${res.status}: ${data.error_description || data.error || 'token request failed'}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Access token lives 24h; refresh a minute early. Refresh token lives 30d,
    // renewed on every refresh, so a running app stays connected indefinitely.
    expiresAt: Date.now() + (Number(data.expires_in) || 86400) * 1000,
  };
}

/** Exchange the authorization code for the first access + refresh tokens. */
export function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return tokenRequest(clientId, clientSecret, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
}

/** Trade a refresh token for a fresh access + refresh token pair. */
export function refreshOAuthTokens(clientId, clientSecret, refreshToken) {
  return tokenRequest(clientId, clientSecret, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

export class SmartThingsPlatform {
  name = 'smartthings';
  label = 'SmartThings';

  /**
   * @param auth  Personal Access Token: { token }
   *              OAuth: { oauth: { clientId, clientSecret, accessToken, refreshToken, expiresAt } }
   * @param onTokenUpdate called with the refreshed oauth object so it can be persisted
   */
  constructor(auth, onTokenUpdate = () => {}) {
    this.auth = auth;
    this.onTokenUpdate = onTokenUpdate;
    this.refreshing = null;
  }

  get usesOAuth() {
    return !!this.auth.oauth;
  }

  /** Returns a currently-valid bearer token, refreshing the OAuth pair if due. */
  async #bearerToken() {
    if (!this.auth.oauth) return this.auth.token; // Personal Access Token
    const o = this.auth.oauth;
    if (o.accessToken && Date.now() < o.expiresAt - 60_000) return o.accessToken;
    this.refreshing ??= (async () => {
      try {
        const fresh = await refreshOAuthTokens(o.clientId, o.clientSecret, o.refreshToken);
        this.auth.oauth = { ...o, ...fresh };
        this.onTokenUpdate(this.auth.oauth);
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
    return this.auth.oauth.accessToken;
  }

  async #request(path, options = {}) {
    const token = await this.#bearerToken();
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 401) {
        hint = this.usesOAuth
          ? ' — OAuth authorization was revoked or the refresh token expired (30d of inactivity); reconnect via “Authorize with SmartThings”'
          : ' — the token is invalid or expired (SmartThings PATs last 24h); switch to “Auto-refresh (OAuth)” to stay connected, or paste a new token';
      }
      throw new Error(`SmartThings API ${res.status} on ${path}: ${body.slice(0, 300)}${hint}`);
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
    const normalized = [];
    for (const d of devices) {
      const n = await this.#normalize(d);
      if (n) normalized.push(n);
    }
    return normalized;
  }

  #capabilities(device) {
    const main = (device.components ?? []).find((c) => c.id === 'main') ?? device.components?.[0];
    return new Set((main?.capabilities ?? []).map((c) => c.id));
  }

  async #normalize(device) {
    const caps = this.#capabilities(device);
    if (!caps.has('switch')) return null; // only actuators for now

    if (caps.has('airConditionerMode') && caps.has('thermostatCoolingSetpoint')) {
      return this.#normalizeAc(device);
    }

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

  /**
   * ACs need one status read up front: it tells us the supported modes
   * (auto/cool/heat/dry/wind), the setpoint limits, and whether the unit
   * reports °C or °F — all of which shape the HomeKit HeaterCooler service.
   */
  async #normalizeAc(device) {
    let modes = ['auto', 'cool', 'heat'];
    let unit = 'C';
    let minC = 16;
    let maxC = 30;
    // Samsung ACs expose the front-panel/display light as a separate capability.
    const panelLight = this.#capabilities(device).has('samsungce.airConditionerLighting');
    try {
      const status = await this.#request(`/devices/${device.deviceId}/status`);
      const main = status.components?.main ?? {};
      unit = main.temperatureMeasurement?.temperature?.unit ?? 'C';
      const supported = main.airConditionerMode?.supportedAcModes?.value;
      if (Array.isArray(supported) && supported.length) modes = supported;
      const setpointCtl = main['custom.thermostatSetpointControl'];
      if (setpointCtl?.minimumSetpoint?.value != null) {
        minC = Math.round(toC(setpointCtl.minimumSetpoint.value, unit));
      }
      if (setpointCtl?.maximumSetpoint?.value != null) {
        maxC = Math.round(toC(setpointCtl.maximumSetpoint.value, unit));
      }
    } catch {
      // fall back to sensible AC defaults if the status read fails
    }
    return {
      id: device.deviceId,
      platform: this.name,
      name: device.label || device.name || 'Air Conditioner',
      model: device.deviceTypeName || device.name || 'SmartThings AC',
      online: true,
      type: 'ac',
      features: {
        power: true,
        brightness: false,
        colorTemp: null,
        color: false,
        ac: { modes, minC, maxC, unit, panelLight },
      },
    };
  }

  async getState(deviceId, device) {
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
    if (device?.features?.ac) {
      const unit = device.features.ac.unit;
      if (main.airConditionerMode?.airConditionerMode) {
        state.mode = main.airConditionerMode.airConditionerMode.value;
      }
      const current = main.temperatureMeasurement?.temperature;
      if (current?.value != null) state.currentC = toC(current.value, current.unit ?? unit);
      const setpoint = main.thermostatCoolingSetpoint?.coolingSetpoint;
      if (setpoint?.value != null) state.targetC = toC(setpoint.value, setpoint.unit ?? unit);
      const lighting = main['samsungce.airConditionerLighting']?.lighting;
      if (lighting?.value != null) state.panelLight = lighting.value === 'on';
    }
    return state;
  }

  async setState(deviceId, changes, device) {
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
    if (changes.mode !== undefined) {
      commands.push({ component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: [changes.mode] });
    }
    if (changes.targetC !== undefined) {
      const unit = device?.features?.ac?.unit ?? 'C';
      commands.push({ component: 'main', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [fromC(changes.targetC, unit)] });
    }
    if (changes.panelLight !== undefined) {
      commands.push({ component: 'main', capability: 'samsungce.airConditionerLighting', command: 'setLightingLevel', arguments: [changes.panelLight ? 'on' : 'off'] });
    }
    if (!commands.length) return;
    await this.#request(`/devices/${deviceId}/commands`, {
      method: 'POST',
      body: JSON.stringify({ commands }),
    });
  }
}
