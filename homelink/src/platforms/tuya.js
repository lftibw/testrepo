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

export class TuyaPlatform {
  name = 'tuya';
  label = 'Wipro / Tuya';

  constructor({ accessId, accessSecret, region = 'eu' }) {
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.baseUrl = TUYA_REGIONS[region] ?? TUYA_REGIONS.eu;
    this.tokenInfo = null; // { accessToken, refreshToken, expiresAt, uid }
    this.specCache = new Map(); // deviceId -> parsed function specs
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
      throw new Error(`Tuya API error on ${path}: ${data.code ?? res.status} ${data.msg ?? ''}`);
    }
    return data.result;
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
    const normalized = [];
    for (const d of devices) {
      const n = await this.#normalize(d);
      if (n) normalized.push(n);
    }
    return normalized;
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
    const status = await this.#rawRequest('GET', `/v1.0/devices/${deviceId}/status`);
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
    await this.#rawRequest('POST', `/v1.0/devices/${deviceId}/commands`, {
      body: { commands },
    });
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
