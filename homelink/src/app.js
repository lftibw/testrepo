/**
 * Application core: owns platform connections, device inventory, and the
 * HomeKit bridge. The web UI drives this through small async methods.
 */

import crypto from 'node:crypto';
import { saveConfig } from './config.js';
import {
  SmartThingsPlatform,
  buildAuthorizeUrl,
  exchangeCode,
} from './platforms/smartthings.js';
import { TuyaPlatform } from './platforms/tuya.js';
import { SmartLifePlatform, createLoginQr, pollLogin } from './platforms/smartlife.js';
import { HomeKitBridge } from './bridge.js';

export class HomeLinkApp {
  constructor(config) {
    this.config = config;
    this.platforms = new Map(); // name -> platform instance
    this.devices = new Map(); // key -> { device, platform }
    this.platformErrors = new Map(); // name -> last error message
    this.bridge = new HomeKitBridge(config);
  }

  async start() {
    if (this.config.smartthings?.oauth) {
      await this.attachSmartThings({ oauth: this.config.smartthings.oauth }).catch((err) =>
        this.platformErrors.set('smartthings', err.message)
      );
    } else if (this.config.smartthings?.token) {
      await this.connectSmartThings(this.config.smartthings, { save: false }).catch((err) =>
        this.platformErrors.set('smartthings', err.message)
      );
    }
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
  }

  async connectSmartThings({ token }, { save = true } = {}) {
    const platform = new SmartThingsPlatform({ token });
    await platform.testConnection();
    this.platforms.set('smartthings', platform);
    this.platformErrors.delete('smartthings');
    if (save) {
      this.config.smartthings = { token };
      saveConfig(this.config);
    }
    await this.refreshDevices();
    return this.deviceCount('smartthings');
  }

  /** Step 1 of OAuth: returns the SmartThings authorize URL to visit. */
  startSmartThingsOAuth({ clientId, clientSecret, redirectUri }) {
    if (!clientId || !clientSecret) throw new Error('OAuth Client ID and Client Secret are required');
    const state = crypto.randomUUID();
    this.pendingSmartThingsOAuth = { clientId, clientSecret, redirectUri, state, createdAt: Date.now() };
    return buildAuthorizeUrl({ clientId, redirectUri, state });
  }

  /** Step 2: OAuth redirect handler exchanges the code and connects. */
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
    const oauth = { clientId: pending.clientId, clientSecret: pending.clientSecret, ...tokens };
    await this.attachSmartThings({ oauth });
    this.config.smartthings = { oauth };
    saveConfig(this.config);
    return this.deviceCount('smartthings');
  }

  async attachSmartThings(auth) {
    const platform = new SmartThingsPlatform(auth, (oauth) => {
      if (this.config.smartthings?.oauth) {
        this.config.smartthings.oauth = oauth;
        saveConfig(this.config);
      }
    });
    await platform.testConnection();
    this.platforms.set('smartthings', platform);
    this.platformErrors.delete('smartthings');
    await this.refreshDevices();
  }

  async connectTuya({ accessId, accessSecret, region }, { save = true } = {}) {
    const platform = new TuyaPlatform({ accessId, accessSecret, region });
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
    await platform.testConnection();
    this.platforms.set('smartlife', platform);
    this.platformErrors.delete('smartlife');
    await this.refreshDevices();
  }

  disconnectPlatform(name) {
    if (name === 'smartlife') {
      this.platforms.get('smartlife')?.logout();
      this.pendingSmartLife = null;
    }
    this.platforms.delete(name);
    this.platformErrors.delete(name);
    this.config[name] = null;
    saveConfig(this.config);
    for (const [key, entry] of this.devices) {
      if (entry.platform.name === name) this.devices.delete(key);
    }
    this.bridge.syncDevices([...this.devices.values()]);
  }

  deviceCount(platformName) {
    let count = 0;
    for (const entry of this.devices.values()) {
      if (entry.platform.name === platformName) count++;
    }
    return count;
  }

  async refreshDevices() {
    for (const platform of this.platforms.values()) {
      try {
        const devices = await platform.listDevices();
        for (const [key, entry] of this.devices) {
          if (entry.platform.name === platform.name) this.devices.delete(key);
        }
        for (const device of devices) {
          this.devices.set(HomeKitBridge.deviceKey(device), { device, platform });
        }
        this.platformErrors.delete(platform.name);
      } catch (err) {
        this.platformErrors.set(platform.name, err.message);
        console.error(`[homelink] ${platform.label} device sync failed:`, err.message);
      }
    }
    this.bridge.syncDevices([...this.devices.values()]);
    await this.bridge.refreshStates().catch(() => {});
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
        ac: !!device.features.ac,
      },
      state: bridged.get(key)?.state ?? {},
    }));
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
          connected: this.platforms.has('smartthings'),
          configured: !!this.config.smartthings,
          method: this.config.smartthings?.oauth ? 'oauth' : this.config.smartthings?.token ? 'token' : null,
          deviceCount: this.deviceCount('smartthings'),
          error: this.platformErrors.get('smartthings') ?? null,
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
