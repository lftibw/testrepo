/**
 * Tuya platform adapter — this is what Wipro smart devices use.
 *
 * Wipro Next Smart Home (and Smart Life) devices are Tuya devices under the
 * hood. Control goes through the Tuya IoT OpenAPI: create a (free) cloud
 * project at https://iot.tuya.com, link your Wipro/Smart Life app account to
 * it by scanning a QR code, and use the project's Access ID / Access Secret
 * here. Note: Wipro Next is an OEM app created before Tuya's 2020-09-22
 * cutoff, so Indian Wipro accounts are usually homed in the Central Europe
 * data center (not India) — see
 * https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed
 *
 * Implements Tuya's HMAC-SHA256 request signing (sign_version 2.0).
 */

import crypto from 'node:crypto';

export const TUYA_REGIONS = {
  in: 'https://openapi.tuyain.com', // India — most Wipro accounts
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  sg: 'https://openapi-sg.iotbing.com',
};

/** Builds the string-to-sign and signature for a Tuya OpenAPI request. */
export function tuyaSign({ clientId, secret, accessToken = '', t, nonce = '', method, path, query = {}, body = '' }) {
  const sortedQuery = Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const url = sortedQuery ? `${path}?${sortedQuery}` : path;
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const stringToSign = [method.toUpperCase(), contentHash, '', url].join('\n');
  const signStr = clientId + accessToken + t + nonce + stringToSign;
  const sign = crypto.createHmac('sha256', secret).update(signStr).digest('hex').toUpperCase();
  return { sign, url };
}

/** Translates Tuya's cryptic error codes into fixes the user can act on. */
const TUYA_ERROR_HINTS = {
  500: 'Tuya-side server error; this usually means the endpoint is not supported by your project type — HomeLink retries newer endpoints automatically, so if you still see this, check that "IoT Core" is authorized for the project (Tuya console → project → Service API / Authorization)',
  1004: 'signature invalid — the Access Secret is wrong (re-copy it from the project overview, no spaces)',
  1005: 'the Access ID (client id) is wrong — re-copy it from the project overview',
  1010: 'token expired — just retry',
  1106: 'permission denied — these credentials usually belong to a DIFFERENT data center; switch the region in HomeLink (Wipro accounts are usually Central Europe) so it matches the project data center',
  1109: 'invalid parameter for this project type',
  2406: 'no app account linked in this data center — link your Wipro app account under Devices → Link App Account with the SAME data center selected',
  28841002: 'the IoT Core trial for this project has expired — renew/resubscribe it in the Tuya console',
  28841101: 'the project is not authorized for this API — in the Tuya console subscribe "IoT Core" and "Authorization Token Management" and add them to the project',
};

export class TuyaPlatform {
  name = 'tuya';
  label = 'Wipro / Tuya';

  constructor({ accessId, accessSecret, region = 'eu' }) {
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.baseUrl = TUYA_REGIONS[region] ?? TUYA_REGIONS.eu;
    this.tokenInfo = null; // { accessToken, refreshToken, expiresAt, uid }
    this.specCache = new Map(); // deviceId -> parsed function specs
    this.variantCache = new Map(); // operation -> index of the endpoint variant this project supports
  }

  async #rawRequest(method, path, { query = {}, body = null, useToken = true } = {}) {
    const t = String(Date.now());
    const nonce = crypto.randomUUID();
    const bodyStr = body ? JSON.stringify(body) : '';
    const accessToken = useToken ? await this.#token() : '';
    const { sign, url } = tuyaSign({
      clientId: this.accessId,
      secret: this.accessSecret,
      accessToken,
      t,
      nonce,
      method,
      path,
      query,
      body: bodyStr,
    });
    const headers = {
      client_id: this.accessId,
      sign,
      t,
      nonce,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    };
    if (accessToken) headers.access_token = accessToken;

    const res = await fetch(this.baseUrl + url, {
      method: method.toUpperCase(),
      headers,
      body: bodyStr || undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const code = data.code ?? res.status;
      const hint = TUYA_ERROR_HINTS[code] ? ` — ${TUYA_ERROR_HINTS[code]}` : '';
      const err = new Error(`Tuya API error on ${path}: ${code} ${data.msg ?? ''}${hint}`);
      err.tuyaCode = code;
      throw err;
    }
    return data.result;
  }

  /**
   * Tries request variants in order (legacy project APIs first, then the
   * endpoints new platform.tuya.com projects support), remembering which one
   * this project accepts so later calls go straight there.
   */
  async #tryVariants(cacheKey, variants) {
    const known = this.variantCache.get(cacheKey) ?? 0;
    const order = [...variants.keys()].sort((a, b) => (a === known ? -1 : b === known ? 1 : a - b));
    let lastErr;
    for (const i of order) {
      try {
        const result = await variants[i].run();
        this.variantCache.set(cacheKey, i);
        return result;
      } catch (err) {
        lastErr = err;
        if (order.length > 1) {
          console.warn(`[homelink] Tuya ${cacheKey} via ${variants[i].name} failed (${err.message})`);
        }
      }
    }
    throw lastErr;
  }

  async #token() {
    if (this.tokenInfo && Date.now() < this.tokenInfo.expiresAt - 60_000) {
      return this.tokenInfo.accessToken;
    }
    const result = await this.#rawRequest('GET', '/v1.0/token', {
      query: { grant_type: '1' },
      useToken: false,
    });
    this.tokenInfo = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + result.expire_time * 1000,
      uid: result.uid,
    };
    return this.tokenInfo.accessToken;
  }

  async testConnection() {
    this.tokenInfo = null;
    await this.#token();
    return { ok: true };
  }

  async listDevices() {
    const devices = await this.#tryVariants('listDevices', [
      { name: 'iot-01 associated-users', run: () => this.#listLegacy() },
      { name: 'v2.0 cloud/thing', run: () => this.#listV2() },
    ]);
    const normalized = [];
    for (const d of devices) {
      const n = await this.#normalize(d);
      if (n) normalized.push(n);
    }
    return normalized;
  }

  /** Device list for classic iot.tuya.com "Smart Home" projects. */
  async #listLegacy() {
    const devices = [];
    let lastRowKey = '';
    while (true) {
      const query = { size: '100' };
      if (lastRowKey) query.last_row_key = lastRowKey;
      const result = await this.#rawRequest('GET', '/v1.0/iot-01/associated-users/devices', { query });
      for (const d of result.devices ?? []) devices.push(d);
      if (!result.has_more || !result.last_row_key) break;
      lastRowKey = result.last_row_key;
    }
    return devices;
  }

  /**
   * Device list for projects on the new developer platform
   * (platform.tuya.com), where the iot-01 endpoint returns "server error".
   * Status is not included in the listing, so it's fetched per device.
   */
  async #listV2() {
    const devices = [];
    let lastId = '';
    while (true) {
      const query = { page_size: '100' };
      if (lastId) query.last_id = lastId;
      const result = await this.#rawRequest('GET', '/v2.0/cloud/thing/device', { query });
      const page = Array.isArray(result) ? result : result?.list ?? [];
      for (const d of page) {
        devices.push({
          id: d.id,
          name: d.custom_name || d.customName || d.name || d.product_name || d.productName,
          product_name: d.product_name || d.productName,
          category: d.category,
          online: (d.is_online ?? d.isOnline) !== false,
          status: null, // filled from the status endpoint in #normalize
        });
      }
      if (page.length < 100) break;
      lastId = page[page.length - 1].id;
    }
    for (const d of devices) {
      try {
        d.status = await this.#status(d.id);
      } catch {
        d.status = [];
      }
    }
    return devices;
  }

  /** Raw data-point list [{code, value}] with fallbacks across project types. */
  async #status(deviceId) {
    return this.#tryVariants('status', [
      { name: 'v1.0 status', run: () => this.#rawRequest('GET', `/v1.0/devices/${deviceId}/status`) },
      { name: 'iot-03 status', run: () => this.#rawRequest('GET', `/v1.0/iot-03/devices/${deviceId}/status`) },
      {
        name: 'v2.0 shadow properties',
        run: async () => {
          const result = await this.#rawRequest('GET', `/v2.0/cloud/thing/${deviceId}/shadow/properties`);
          return (result?.properties ?? []).map((p) => ({ code: p.code, value: p.value }));
        },
      },
    ]);
  }

  /**
   * Fetches and caches the device's data-point specifications so we can map
   * Tuya's varying value ranges (v1 vs v2 data points) accurately.
   */
  async #specs(deviceId) {
    if (this.specCache.has(deviceId)) return this.specCache.get(deviceId);
    let specs = { functions: new Map() };
    try {
      const result = await this.#rawRequest('GET', `/v1.0/devices/${deviceId}/specifications`);
      for (const fn of result.functions ?? []) {
        let values = {};
        try { values = JSON.parse(fn.values || '{}'); } catch { /* some DPs have empty specs */ }
        specs.functions.set(fn.code, { type: fn.type, values });
      }
    } catch {
      // Specifications endpoint can be unavailable for some products; fall back to defaults
    }
    this.specCache.set(deviceId, specs);
    return specs;
  }

  #dpCodes(device) {
    return new Set((device.status ?? []).map((s) => s.code));
  }

  async #normalize(device) {
    const codes = this.#dpCodes(device);
    const powerCode = ['switch_led', 'switch', 'switch_1'].find((c) => codes.has(c));
    if (!powerCode) return null; // only actuators for now

    // dj = light, dc = string light, dd = strip, xdd = ceiling light, fwd = ambience
    const lightCategories = new Set(['dj', 'dc', 'dd', 'xdd', 'fwd', 'gyd', 'tyndj']);
    const outletCategories = new Set(['cz', 'pc', 'kg']);
    let type = 'switch';
    if (powerCode === 'switch_led' || lightCategories.has(device.category)) type = 'light';
    else if (outletCategories.has(device.category)) type = device.category === 'kg' ? 'switch' : 'outlet';

    const specs = await this.#specs(device.id);
    const brightCode = ['bright_value_v2', 'bright_value'].find((c) => codes.has(c));
    const tempCode = ['temp_value_v2', 'temp_value'].find((c) => codes.has(c));
    const colorCode = ['colour_data_v2', 'colour_data'].find((c) => codes.has(c));

    return {
      id: device.id,
      platform: this.name,
      name: device.name || 'Wipro Device',
      model: device.product_name || 'Tuya',
      online: device.online !== false,
      type,
      features: {
        power: true,
        brightness: !!brightCode,
        colorTemp: tempCode ? { minK: 2700, maxK: 6500 } : null,
        color: !!colorCode,
      },
      // Tuya-specific mapping details used by getState/setState
      _tuya: {
        powerCode,
        brightCode,
        brightRange: this.#range(specs, brightCode, { min: 10, max: 1000 }),
        tempCode,
        tempRange: this.#range(specs, tempCode, { min: 0, max: 1000 }),
        colorCode,
        colorIsV2: colorCode === 'colour_data_v2',
      },
    };
  }

  #range(specs, code, fallback) {
    if (!code) return fallback;
    const values = specs.functions.get(code)?.values;
    if (values && typeof values.min === 'number' && typeof values.max === 'number') {
      return { min: values.min, max: values.max };
    }
    return fallback;
  }

  // Tuya reports state per data point; we keep the mapping info on the device.
  async getState(deviceId, device) {
    const status = await this.#status(deviceId);
    const dp = Object.fromEntries(status.map((s) => [s.code, s.value]));
    const m = device._tuya;
    const state = {};
    if (m.powerCode in dp) state.power = !!dp[m.powerCode];

    const workMode = dp.work_mode; // 'white' | 'colour' | scenes
    if (m.brightCode && m.brightCode in dp) {
      state.brightness = this.#toPercent(dp[m.brightCode], m.brightRange);
    }
    if (m.tempCode && m.tempCode in dp) {
      // Tuya temp scale: min = warm (2700K), max = cool (6500K)
      const pct = this.#toPercent(dp[m.tempCode], m.tempRange);
      state.colorTempK = Math.round(2700 + (pct / 100) * (6500 - 2700));
    }
    if (m.colorCode && dp[m.colorCode]) {
      try {
        const c = typeof dp[m.colorCode] === 'string' ? JSON.parse(dp[m.colorCode]) : dp[m.colorCode];
        const sMax = m.colorIsV2 ? 1000 : 255;
        const vMax = m.colorIsV2 ? 1000 : 255;
        state.hue = Number(c.h) || 0;
        state.saturation = Math.round(((Number(c.s) || 0) / sMax) * 100);
        if (workMode === 'colour') {
          state.brightness = Math.round(((Number(c.v) || 0) / vMax) * 100);
        }
      } catch { /* unexpected colour_data payload */ }
    }
    return state;
  }

  async setState(deviceId, changes, device) {
    const m = device._tuya;
    const commands = [];
    if (changes.power !== undefined) {
      commands.push({ code: m.powerCode, value: !!changes.power });
    }
    if ((changes.hue !== undefined || changes.saturation !== undefined) && m.colorCode) {
      const sMax = m.colorIsV2 ? 1000 : 255;
      const vMax = m.colorIsV2 ? 1000 : 255;
      const brightness = changes.brightness ?? changes._currentBrightness ?? 100;
      commands.push({ code: 'work_mode', value: 'colour' });
      commands.push({
        code: m.colorCode,
        value: {
          h: Math.round(Math.max(0, Math.min(360, changes.hue ?? 0))),
          s: Math.round(((changes.saturation ?? 100) / 100) * sMax),
          v: Math.round((brightness / 100) * vMax),
        },
      });
    } else {
      if (changes.colorTempK !== undefined && m.tempCode) {
        const pct = ((changes.colorTempK - 2700) / (6500 - 2700)) * 100;
        commands.push({ code: 'work_mode', value: 'white' });
        commands.push({ code: m.tempCode, value: this.#fromPercent(pct, m.tempRange) });
      }
      if (changes.brightness !== undefined && m.brightCode) {
        commands.push({ code: m.brightCode, value: this.#fromPercent(changes.brightness, m.brightRange) });
      }
    }
    if (!commands.length) return;
    await this.#tryVariants('commands', [
      {
        name: 'v1.0 commands',
        run: () => this.#rawRequest('POST', `/v1.0/devices/${deviceId}/commands`, { body: { commands } }),
      },
      {
        name: 'iot-03 commands',
        run: () => this.#rawRequest('POST', `/v1.0/iot-03/devices/${deviceId}/commands`, { body: { commands } }),
      },
      {
        name: 'v2.0 shadow properties issue',
        run: () => this.#rawRequest('POST', `/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`, {
          body: { properties: JSON.stringify(Object.fromEntries(commands.map((c) => [c.code, c.value]))) },
        }),
      },
    ]);
  }

  #toPercent(value, range) {
    const clamped = Math.max(range.min, Math.min(range.max, Number(value) || 0));
    return Math.round(((clamped - range.min) / (range.max - range.min)) * 100);
  }

  #fromPercent(pct, range) {
    const p = Math.max(0, Math.min(100, pct));
    return Math.round(range.min + (p / 100) * (range.max - range.min));
  }
}
