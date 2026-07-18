/**
 * Application core: owns platform connections, device inventory, and the
 * HomeKit bridge. The web UI drives this through small async methods.
 */

import crypto from 'node:crypto';
import { saveConfig, dataDir } from './config.js';
import { computeEnergy } from './energy.js';
import { EnergyTracker } from './energy-tracker.js';
import {
  SmartThingsPlatform,
  buildAuthorizeUrl,
  exchangeCode,
} from './platforms/smartthings.js';
import { TuyaPlatform } from './platforms/tuya.js';
import { SmartLifePlatform, createLoginQr, pollLogin } from './platforms/smartlife.js';
import { HomeKitBridge } from './bridge.js';

/** Connection id for a SmartThings account (platforms are keyed by this). */
const connIdFor = (accountId) => `smartthings:${accountId}`;

export class HomeLinkApp {
  constructor(config) {
    this.config = config;
    this.platforms = new Map(); // name -> platform instance
    this.devices = new Map(); // key -> { device, platform }
    this.platformErrors = new Map(); // name -> last error message
    this.timers = new Map(); // device key -> { timeout, firesAt } auto-off timers
    this.energyTracker = new EnergyTracker(dataDir());
    this.bridge = new HomeKitBridge(config);
  }

  async start() {
    for (const account of this.#stAccounts()) {
      await this.attachSmartThingsAccount(account).catch((err) =>
        this.platformErrors.set(connIdFor(account.id), err.message)
      );
    }
    saveConfig(this.config); // persist any legacy→accounts migration
    if (this.config.tuya?.accessId) {
      await this.connectTuya(this.config.tuya, { save: false }).catch((err) =>
        this.platformErrors.set('tuya', err.message)
      );
    }
    if (this.config.smartlife?.tokenInfo) {
      await this.attachSmartLife(this.config.smartlife).catch((err) =>
        this.platformErrors.set('smartlife', err.message)
      );
    }
    await this.bridge.publish();
    this.deviceRefreshTimer = setInterval(() => {
      this.refreshDevices().catch((err) => console.error('[homelink] device refresh error:', err.message));
    }, 5 * 60_000);
    // Accumulate total energy consumption once a minute.
    this.sampleEnergy();
    this.energyTimer = setInterval(() => this.sampleEnergy(), 60_000);
  }

  /**
   * Returns the SmartThings accounts array, migrating a legacy single-account
   * config (config.smartthings) into it the first time it's accessed.
   */
  #stAccounts() {
    if (!Array.isArray(this.config.smartthingsAccounts)) this.config.smartthingsAccounts = [];
    if (this.config.smartthings) {
      const legacy = this.config.smartthings;
      this.config.smartthingsAccounts.push({
        id: crypto.randomUUID(),
        label: 'SmartThings',
        ...(legacy.oauth ? { oauth: legacy.oauth } : { token: legacy.token }),
      });
      this.config.smartthings = null;
    }
    return this.config.smartthingsAccounts;
  }

  /** Connects one SmartThings account (PAT or OAuth) and registers it. */
  async attachSmartThingsAccount(account) {
    const auth = account.oauth ? { oauth: account.oauth } : { token: account.token };
    const connId = connIdFor(account.id);
    const platform = new SmartThingsPlatform(auth, (oauth) => {
      const acc = this.#stAccounts().find((a) => a.id === account.id);
      if (acc) {
        acc.oauth = oauth;
        saveConfig(this.config);
      }
    });
    platform.connId = connId;
    platform.accountId = account.id;
    platform.accountLabel = account.label;
    await platform.testConnection();
    this.platforms.set(connId, platform);
    this.platformErrors.delete(connId);
    await this.refreshDevices();
  }

  /** Adds a SmartThings account via Personal Access Token. */
  async connectSmartThings({ token, label }) {
    const account = { id: crypto.randomUUID(), label: (label || '').trim() || 'SmartThings', token };
    await this.attachSmartThingsAccount(account);
    this.#stAccounts().push(account);
    saveConfig(this.config);
    return this.deviceCountByConn(connIdFor(account.id));
  }

  /** Step 1 of OAuth: returns the SmartThings authorize URL to visit. */
  startSmartThingsOAuth({ clientId, clientSecret, redirectUri, label }) {
    if (!clientId || !clientSecret) throw new Error('OAuth Client ID and Client Secret are required');
    const state = crypto.randomUUID();
    this.pendingSmartThingsOAuth = { clientId, clientSecret, redirectUri, state, label, createdAt: Date.now() };
    return buildAuthorizeUrl({ clientId, redirectUri, state });
  }

  /** Step 2: OAuth redirect handler exchanges the code and adds the account. */
  async completeSmartThingsOAuth({ code, state }) {
    const pending = this.pendingSmartThingsOAuth;
    if (!pending || pending.state !== state) throw new Error('OAuth state mismatch — restart the authorization from HomeLink');
    this.pendingSmartThingsOAuth = null;
    const tokens = await exchangeCode({
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      code,
      redirectUri: pending.redirectUri,
    });
    const account = {
      id: crypto.randomUUID(),
      label: (pending.label || '').trim() || 'SmartThings',
      oauth: { clientId: pending.clientId, clientSecret: pending.clientSecret, ...tokens },
    };
    await this.attachSmartThingsAccount(account);
    this.#stAccounts().push(account);
    saveConfig(this.config);
    return this.deviceCountByConn(connIdFor(account.id));
  }

  async connectTuya({ accessId, accessSecret, region }, { save = true } = {}) {
    const platform = new TuyaPlatform({ accessId, accessSecret, region });
    platform.connId = 'tuya';
    await platform.testConnection();
    this.platforms.set('tuya', platform);
    this.platformErrors.delete('tuya');
    if (save) {
      this.config.tuya = { accessId, accessSecret, region };
      saveConfig(this.config);
    }
    await this.refreshDevices();
    return this.deviceCount('tuya');
  }

  /** Step 1 of Smart Life login: returns the QR content to display. */
  async startSmartLifeLogin(userCode) {
    const { token, qrContent } = await createLoginQr(userCode);
    this.pendingSmartLife = { token, userCode };
    return { token, qrContent };
  }

  /** Step 2: called repeatedly by the UI until the app approves the login. */
  async pollSmartLifeLogin() {
    if (!this.pendingSmartLife) throw new Error('No Smart Life login in progress');
    const { token, userCode } = this.pendingSmartLife;
    const result = await pollLogin(token, userCode);
    if (result.pending) return { pending: true };
    this.pendingSmartLife = null;
    await this.attachSmartLife(result.credentials);
    this.config.smartlife = result.credentials;
    saveConfig(this.config);
    return { pending: false, deviceCount: this.deviceCount('smartlife') };
  }

  async attachSmartLife(credentials) {
    const platform = new SmartLifePlatform(credentials, (tokenInfo) => {
      if (this.config.smartlife) {
        this.config.smartlife.tokenInfo = tokenInfo;
        saveConfig(this.config);
      }
    });
    platform.connId = 'smartlife';
    await platform.testConnection();
    this.platforms.set('smartlife', platform);
    this.platformErrors.delete('smartlife');
    await this.refreshDevices();
  }

  /** Disconnects one connection by id: 'tuya', 'smartlife', or 'smartthings:<accountId>'. */
  disconnectPlatform(connId) {
    const platform = this.platforms.get(connId);
    if (connId === 'smartlife') {
      platform?.logout();
      this.pendingSmartLife = null;
      this.config.smartlife = null;
    } else if (connId === 'tuya') {
      this.config.tuya = null;
    } else if (connId.startsWith('smartthings:')) {
      const id = connId.slice('smartthings:'.length);
      this.config.smartthingsAccounts = this.#stAccounts().filter((a) => a.id !== id);
    }
    this.platforms.delete(connId);
    this.platformErrors.delete(connId);
    saveConfig(this.config);
    for (const [key, entry] of this.devices) {
      if (entry.platform === platform) this.devices.delete(key);
    }
    this.bridge.syncDevices([...this.devices.values()]);
  }

  /** Devices from all connections of a kind ('smartthings' | 'tuya' | 'smartlife'). */
  deviceCount(platformName) {
    let count = 0;
    for (const entry of this.devices.values()) {
      if (entry.platform.name === platformName) count++;
    }
    return count;
  }

  /** Devices from a single connection. */
  deviceCountByConn(connId) {
    let count = 0;
    for (const entry of this.devices.values()) {
      if (entry.platform.connId === connId) count++;
    }
    return count;
  }

  async refreshDevices() {
    for (const platform of this.platforms.values()) {
      try {
        const devices = await platform.listDevices();
        // Clear only THIS connection's devices (identity, not kind) so
        // multiple SmartThings accounts don't wipe each other out.
        for (const [key, entry] of this.devices) {
          if (entry.platform === platform) this.devices.delete(key);
        }
        for (const device of devices) {
          this.devices.set(HomeKitBridge.deviceKey(device), { device, platform });
        }
        this.platformErrors.delete(platform.connId);
      } catch (err) {
        this.platformErrors.set(platform.connId, err.message);
        const who = platform.accountLabel ? `${platform.label} (${platform.accountLabel})` : platform.label;
        console.error(`[homelink] ${who} device sync failed:`, err.message);
      }
    }
    this.bridge.syncDevices([...this.devices.values()]);
    await this.bridge.refreshStates().catch(() => {});
  }

  /**
   * Controls a device from the web remote: sends the change to the platform
   * cloud, then mirrors it into the HomeKit bridge so the Home app matches.
   */
  async controlDevice(key, changes) {
    const entry = this.devices.get(key);
    if (!entry) throw new Error('Unknown device');
    const allowed = ['power', 'brightness', 'colorTempK', 'hue', 'saturation', 'mode', 'targetC', 'panelLight', 'optionalMode'];
    const clean = {};
    for (const k of allowed) if (changes[k] !== undefined) clean[k] = changes[k];
    if (!Object.keys(clean).length) throw new Error('No supported control values provided');

    // Tuya colour commands need the current brightness for the HSV "value".
    const outbound = { ...clean };
    if ((clean.hue !== undefined || clean.saturation !== undefined) && clean.brightness === undefined) {
      outbound._currentBrightness = this.bridge.getState(key)?.brightness;
    }
    await entry.platform.setState(entry.device.id, outbound, entry.device);
    this.bridge.reflectExternalChange(key, clean);
    // An action can cause side-effects on the device (e.g. Max shifting the
    // setpoint). Re-read the real state shortly after so the cached state —
    // which the web remote and HomeKit both read — reflects them.
    this.#scheduleStateReread(key);
    return { ok: true, state: this.bridge.getState(key) ?? clean };
  }

  #scheduleStateReread(key) {
    for (const ms of [900, 2200]) {
      const t = setTimeout(() => this.#rereadDeviceState(key), ms);
      t.unref?.();
    }
  }

  async #rereadDeviceState(key) {
    const entry = this.devices.get(key);
    if (!entry) return;
    try {
      const state = await entry.platform.getState(entry.device.id, entry.device);
      this.bridge.reflectExternalChange(key, state);
    } catch { /* transient; the periodic poll will catch up */ }
  }

  /**
   * Applies one change to every device (optionally filtered by type), e.g.
   * "all lights off". Returns how many succeeded.
   */
  async controlScene({ types = null, changes }) {
    const targets = [...this.devices.entries()].filter(
      ([, e]) => !types || types.includes(e.device.type)
    );
    const results = await Promise.allSettled(targets.map(([key]) => this.controlDevice(key, changes)));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) console.error('[homelink] scene: %d/%d failed', failed.length, targets.length);
    return { total: targets.length, ok: results.length - failed.length };
  }

  /** Schedules the device to turn off after `minutes` (0/null cancels). */
  setDeviceTimer(key, minutes) {
    if (!this.devices.has(key)) throw new Error('Unknown device');
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.timeout);
    this.timers.delete(key);
    if (!minutes || minutes <= 0) return { firesAt: null };
    const ms = Math.min(minutes, 24 * 60) * 60_000;
    const firesAt = Date.now() + ms;
    const timeout = setTimeout(() => {
      this.timers.delete(key);
      this.controlDevice(key, { power: false }).catch((err) =>
        console.error(`[homelink] auto-off "${key}" failed:`, err.message)
      );
    }, ms);
    timeout.unref?.();
    this.timers.set(key, { timeout, firesAt });
    return { firesAt };
  }

  /** Diagnostics: normalized features plus (for SmartThings) the raw status. */
  async deviceDebug(key) {
    const entry = this.devices.get(key);
    if (!entry) throw new Error('Unknown device');
    const out = {
      key,
      platform: entry.platform.name,
      account: entry.platform.accountLabel ?? null,
      name: entry.device.name,
      type: entry.device.type,
      features: entry.device.features,
    };
    if (typeof entry.platform.rawStatus === 'function') {
      out.raw = await entry.platform.rawStatus(entry.device.id).catch((e) => ({ error: e.message }));
    }
    return out;
  }

  setDeviceExcluded(key, excluded) {
    const set = new Set(this.config.excludedDevices ?? []);
    if (excluded) set.add(key);
    else set.delete(key);
    this.config.excludedDevices = [...set];
    saveConfig(this.config);
    this.bridge.syncDevices([...this.devices.values()]);
  }

  allDevices() {
    const excluded = new Set(this.config.excludedDevices ?? []);
    const bridged = new Map(this.bridge.listBridged().map((b) => [b.key, b]));
    return [...this.devices.entries()].map(([key, { device, platform }]) => ({
      key,
      platform: platform.name,
      platformLabel: platform.label,
      account: platform.accountLabel ?? null,
      name: device.name,
      model: device.model,
      type: device.type,
      online: device.online,
      excluded: excluded.has(key),
      features: {
        power: device.features.power,
        brightness: device.features.brightness,
        colorTemp: !!device.features.colorTemp,
        color: device.features.color,
        ac: device.features.ac
          ? {
            modes: device.features.ac.modes, minC: device.features.ac.minC, maxC: device.features.ac.maxC,
            panelLight: !!device.features.ac.panelLight, optionalModes: device.features.ac.optionalModes ?? [],
          }
          : false,
      },
      state: bridged.get(key)?.state ?? {},
      timerFiresAt: this.timers.get(key)?.firesAt ?? null,
      energy: this.#energyView(device, bridged.get(key)?.state ?? {}, key),
    }));
  }

  #energyView(device, state, key) {
    const e = computeEnergy(device, state, this.config.energy);
    const total = this.energyTracker.total(key);
    e.totalKwh = total.kwh;
    e.since = total.since;
    const price = Number(this.config.energy?.pricePerKwh) || 0;
    e.totalCost = Number((total.kwh * price).toFixed(2));
    return e;
  }

  /** Samples current draw for every device into the cumulative energy tracker. */
  sampleEnergy() {
    const entries = [];
    for (const [key, { device }] of this.devices) {
      const state = this.bridge.getState(key) ?? {};
      const e = computeEnergy(device, state, this.config.energy);
      entries.push({ key, watts: e.watts, energyKwh: e.kwh });
    }
    this.energyTracker.sample(entries);
  }

  resetDeviceEnergy(key) {
    if (!this.devices.has(key)) throw new Error('Unknown device');
    this.energyTracker.reset(key);
    return { ok: true };
  }

  energyRate() {
    return this.config.energy ?? { currency: '', pricePerKwh: 0 };
  }

  setEnergyRate({ currency, pricePerKwh }) {
    const price = Number(pricePerKwh);
    this.config.energy = {
      currency: typeof currency === 'string' && currency.trim() ? currency.trim().slice(0, 4) : this.config.energy?.currency ?? '',
      pricePerKwh: Number.isFinite(price) && price >= 0 ? price : this.config.energy?.pricePerKwh ?? 0,
    };
    saveConfig(this.config);
    return this.config.energy;
  }

  status() {
    return {
      bridge: {
        name: this.config.bridge.name,
        pincode: this.config.bridge.pincode,
        port: this.config.bridge.port,
        paired: this.bridge.isPaired(),
        setupURI: this.bridge.published ? this.bridge.setupURI() : null,
      },
      platforms: {
        smartthings: {
          deviceCount: this.deviceCount('smartthings'),
          accounts: this.#stAccounts().map((a) => {
            const connId = connIdFor(a.id);
            return {
              connId,
              label: a.label,
              method: a.oauth ? 'oauth' : 'token',
              connected: this.platforms.has(connId),
              deviceCount: this.deviceCountByConn(connId),
              error: this.platformErrors.get(connId) ?? null,
            };
          }),
        },
        tuya: {
          connected: this.platforms.has('tuya'),
          configured: !!this.config.tuya,
          region: this.config.tuya?.region ?? 'eu',
          deviceCount: this.deviceCount('tuya'),
          error: this.platformErrors.get('tuya') ?? null,
        },
        smartlife: {
          connected: this.platforms.has('smartlife'),
          configured: !!this.config.smartlife,
          deviceCount: this.deviceCount('smartlife'),
          error: this.platformErrors.get('smartlife') ?? null,
        },
      },
    };
  }
}
