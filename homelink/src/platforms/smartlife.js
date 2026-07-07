/**
 * Smart Life app login — connect Wipro/Tuya devices WITHOUT a Tuya
 * developer account or cloud project.
 *
 * This is a Node port of Tuya's official `tuya-device-sharing-sdk`
 * (https://github.com/tuya/tuya-device-sharing-sdk), the auth used by Home
 * Assistant's official Tuya integration:
 *   1. The user reads their "user code" from the Smart Life app
 *      (Me → Settings → Account and Security → User Code).
 *   2. We request a QR login token, show the QR, the user scans it with the
 *      Smart Life app and approves.
 *   3. Polling the token returns access/refresh tokens plus the region
 *      endpoint; all further calls are AES-GCM-encrypted + HMAC-signed.
 *
 * The QR must be scanned with the SMART LIFE app — Wipro Next cannot
 * approve these logins, so Wipro bulbs must be paired into Smart Life
 * (they are ordinary Tuya devices; reset and re-add them there).
 */

import crypto from 'node:crypto';
import { buildMapping, dpToState, stateToCommands } from './tuya-dp.js';

const LOGIN_BASE = 'https://apigw.iotbing.com';
// Client identity used by Home Assistant's official integration
// (homeassistant/components/tuya/const.py — must match or the data API
// rejects every call with "-9999999 Invalid client;No access")
export const SMARTLIFE_CLIENT_ID = 'HA_3y9q4ak7g4ephrvke';
export const SMARTLIFE_SCHEMA = 'haauthorize';

const md5hex = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/** Port of the SDK's _secret_generating (sid is always "" in the SDK). */
export function deriveSecret(rid, hashKey) {
  return crypto.createHmac('sha256', Buffer.from(rid, 'utf8'))
    .update(Buffer.from(hashKey, 'utf8'))
    .digest('hex')
    .slice(0, 16);
}

const NONCE_CHARSET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
function randomNonce(length = 12) {
  let out = '';
  for (let i = 0; i < length; i++) out += NONCE_CHARSET[crypto.randomInt(NONCE_CHARSET.length)];
  return out;
}

/** AES-128-GCM, returns base64(nonce) + base64(ciphertext+tag) like the SDK. */
export function aesGcmEncrypt(plaintext, secret, nonce = randomNonce()) {
  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), Buffer.from(nonce, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(nonce, 'utf8').toString('base64') + enc.toString('base64');
}

export function aesGcmDecrypt(encdata, secret) {
  const raw = Buffer.from(encdata, 'base64');
  const nonce = raw.subarray(0, 12);
  const body = raw.subarray(12);
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(0, body.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Port of _restful_sign: HMAC over "k=v||…" headers + encrypted payloads. */
export function restfulSign(hashKey, queryEncdata, bodyEncdata, headers) {
  const order = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token'];
  let signStr = order
    .filter((k) => headers[k])
    .map((k) => `${k}=${headers[k]}`)
    .join('||');
  if (queryEncdata) signStr += queryEncdata;
  if (bodyEncdata) signStr += bodyEncdata;
  return crypto.createHmac('sha256', Buffer.from(hashKey, 'utf8')).update(Buffer.from(signStr, 'utf8')).digest('hex');
}

/**
 * Step 1 of login: create a QR token. Returns { token, qrContent } where
 * qrContent is what the Smart Life app expects to scan.
 */
export async function createLoginQr(userCode) {
  const url = `${LOGIN_BASE}/v1.0/m/life/home-assistant/qrcode/tokens` +
    `?clientid=${encodeURIComponent(SMARTLIFE_CLIENT_ID)}&usercode=${encodeURIComponent(userCode)}&schema=${SMARTLIFE_SCHEMA}`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    throw new Error(`Smart Life login setup failed: ${data.code ?? res.status} ${data.msg ?? ''}` +
      (data.code === 1108 || data.code === 2406 ? ' — double-check the user code from Smart Life → Me → Settings → Account and Security' : ''));
  }
  const token = data.result?.qrcode;
  return { token, qrContent: `tuyaSmart--qrLogin?token=${token}` };
}

/**
 * Step 2: poll until the user scans + approves in the Smart Life app.
 * Resolves { pending: true } until approved; then returns the credentials.
 */
export async function pollLogin(token, userCode) {
  const url = `${LOGIN_BASE}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(token)}` +
    `?clientid=${encodeURIComponent(SMARTLIFE_CLIENT_ID)}&usercode=${encodeURIComponent(userCode)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!data.success) return { pending: true, code: data.code, msg: data.msg };
  const r = data.result ?? {};
  return {
    pending: false,
    credentials: {
      userCode,
      endpoint: r.endpoint,
      terminalId: r.terminal_id,
      tokenInfo: {
        t: data.t ?? Date.now(),
        uid: r.uid,
        expireTime: r.expire_time,
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
      },
    },
  };
}

export class SmartLifePlatform {
  name = 'smartlife';
  label = 'Wipro / Smart Life';

  /**
   * @param credentials output of pollLogin().credentials
   * @param onTokenUpdate called with fresh tokenInfo after a refresh (persist it)
   */
  constructor(credentials, onTokenUpdate = () => {}) {
    this.creds = credentials;
    this.onTokenUpdate = onTokenUpdate;
    this.deviceCache = new Map(); // id -> mapping info
    this.refreshing = null;
  }

  #expiresAt() {
    const t = this.creds.tokenInfo;
    return (t.t ?? 0) + (t.expireTime ?? 0) * 1000;
  }

  async #refreshTokenIfNeeded() {
    if (Date.now() < this.#expiresAt() - 60_000) return;
    this.refreshing ??= (async () => {
      try {
        const data = await this.#signedRequest('GET', `/v1.0/m/token/${this.creds.tokenInfo.refreshToken}`, null, null, true);
        const r = data.result ?? {};
        this.creds.tokenInfo = {
          t: data.t ?? Date.now(),
          uid: r.uid,
          expireTime: r.expireTime,
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
        };
        this.onTokenUpdate(this.creds.tokenInfo);
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
  }

  async #signedRequest(method, path, query = null, body = null, skipRefresh = false) {
    if (!skipRefresh) await this.#refreshTokenIfNeeded();

    const rid = crypto.randomUUID();
    const hashKey = md5hex(rid + this.creds.tokenInfo.refreshToken);
    const secret = deriveSecret(rid, hashKey);

    let queryEncdata = '';
    let url = this.creds.endpoint + path;
    if (query && Object.keys(query).length) {
      queryEncdata = aesGcmEncrypt(JSON.stringify(query), secret);
      url += `?encdata=${encodeURIComponent(queryEncdata)}`;
    }
    let bodyEncdata = '';
    let bodyPayload;
    if (body && Object.keys(body).length) {
      bodyEncdata = aesGcmEncrypt(JSON.stringify(body), secret);
      bodyPayload = JSON.stringify({ encdata: bodyEncdata });
    }

    const headers = {
      'X-appKey': SMARTLIFE_CLIENT_ID,
      'X-requestId': rid,
      'X-sid': '',
      'X-time': String(Date.now()),
    };
    if (this.creds.tokenInfo.accessToken) headers['X-token'] = this.creds.tokenInfo.accessToken;
    headers['X-sign'] = restfulSign(hashKey, queryEncdata, bodyEncdata, headers);

    const res = await fetch(url, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: bodyPayload,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(`Smart Life API error on ${path}: ${data.code ?? res.status} ${data.msg ?? ''}`);
    }
    if (typeof data.result === 'string' && data.result) {
      const decrypted = aesGcmDecrypt(data.result, secret);
      try { data.result = JSON.parse(decrypted); } catch { data.result = decrypted; }
    }
    return data;
  }

  async testConnection() {
    await this.#signedRequest('GET', '/v1.0/m/life/users/homes');
    return { ok: true };
  }

  async listDevices() {
    const homes = (await this.#signedRequest('GET', '/v1.0/m/life/users/homes')).result ?? [];
    const raw = [];
    for (const home of homes) {
      const devices = (await this.#signedRequest('GET', '/v1.0/m/life/ha/home/devices', { homeId: String(home.ownerId) })).result ?? [];
      raw.push(...devices);
    }
    const normalized = [];
    for (const d of raw) {
      const statusList = Array.isArray(d.status) ? d.status : [];
      const codes = new Set(statusList.map((s) => s.code));
      const specRange = await this.#specRange(d.id);
      const mapping = buildMapping(codes, d.category, specRange);
      if (!mapping) continue;
      this.deviceCache.set(d.id, mapping._tuya);
      normalized.push({
        id: d.id,
        platform: this.name,
        name: d.name || d.product_name || 'Wipro Device',
        model: d.product_name || 'Smart Life',
        online: d.online !== false,
        type: mapping.type,
        features: mapping.features,
        _tuya: mapping._tuya,
      });
    }
    return normalized;
  }

  /** Returns a specRange(code) lookup from /specifications, or nulls on failure. */
  async #specRange(deviceId) {
    try {
      const result = (await this.#signedRequest('GET', `/v1.1/m/life/${deviceId}/specifications`)).result ?? {};
      const ranges = new Map();
      for (const fn of result.functions ?? []) {
        let values = fn.values;
        if (typeof values === 'string') {
          try { values = JSON.parse(values || '{}'); } catch { values = {}; }
        }
        if (values && typeof values.min === 'number' && typeof values.max === 'number') {
          ranges.set(fn.code, { min: values.min, max: values.max });
        }
      }
      return (code) => (code && ranges.has(code) ? ranges.get(code) : null);
    } catch {
      return () => null;
    }
  }

  async getState(deviceId, device) {
    const data = await this.#signedRequest('GET', '/v1.0/m/life/ha/devices/detail', { devIds: deviceId });
    const detail = (data.result ?? [])[0];
    if (!detail) return {};
    const dp = Object.fromEntries((detail.status ?? []).map((s) => [s.code, s.value]));
    return dpToState(dp, device._tuya ?? this.deviceCache.get(deviceId));
  }

  async setState(deviceId, changes, device) {
    const commands = stateToCommands(changes, device._tuya ?? this.deviceCache.get(deviceId));
    if (!commands.length) return;
    await this.#signedRequest('POST', `/v1.1/m/thing/${deviceId}/commands`, null, { commands });
  }

  /** Invalidates this terminal's session server-side (called on disconnect). */
  async logout() {
    try {
      await this.#signedRequest('POST', '/v1.0/m/token/terminal/expire', null, {
        accessToken: this.creds.tokenInfo.accessToken,
        terminalId: this.creds.terminalId,
      });
    } catch { /* best effort */ }
  }
}
