import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeLinkApp } from '../src/app.js';

function fakeStPlatform(connId, accountLabel, devices) {
  return {
    name: 'smartthings',
    label: 'SmartThings',
    connId,
    accountLabel,
    async listDevices() { return devices; },
    async getState() { return {}; },
    async setState() {},
  };
}

function stDevice(id, name) {
  return {
    id, platform: 'smartthings', name, model: 'x', online: true, type: 'switch',
    features: { power: true, brightness: false, colorTemp: null, color: false },
  };
}

function lightDevice(id, name, extra = {}) {
  return {
    id, platform: 'smartthings', name, model: 'bulb', online: true, type: 'light',
    features: { power: true, brightness: true, colorTemp: { minK: 2700, maxK: 6500 }, color: true, ...extra },
  };
}

function controllablePlatform(devices, getState, onSet) {
  return {
    name: 'smartthings', label: 'SmartThings', connId: 'smartthings:c',
    async listDevices() { return devices; },
    async getState() { return getState(); },
    async setState(id, changes, device) { onSet({ id, changes, device }); },
  };
}

function baseConfig() {
  return {
    bridge: { name: 'Test', username: '02:00:00:00:00:9A', pincode: '111-22-333', port: 51999 },
    smartthingsAccounts: [],
    excludedDevices: [],
  };
}

test('two SmartThings accounts keep their devices independently', async () => {
  const app = new HomeLinkApp(baseConfig());
  const a = fakeStPlatform('smartthings:a', 'Mine', [stDevice('dev-a1', 'My Light')]);
  const b = fakeStPlatform('smartthings:b', 'Brother', [stDevice('dev-b1', 'Bro AC'), stDevice('dev-b2', 'Bro Plug')]);
  app.platforms.set('smartthings:a', a);
  app.platforms.set('smartthings:b', b);

  await app.refreshDevices();

  // Before the fix, refreshing account B wiped account A's devices (cleared by
  // platform *name*). Each account must keep its own.
  assert.equal(app.deviceCountByConn('smartthings:a'), 1);
  assert.equal(app.deviceCountByConn('smartthings:b'), 2);
  assert.equal(app.deviceCount('smartthings'), 3);

  // Disconnecting one account leaves the other intact.
  app.disconnectPlatform('smartthings:b');
  assert.equal(app.deviceCountByConn('smartthings:a'), 1);
  assert.equal(app.deviceCountByConn('smartthings:b'), 0);
  assert.equal(app.deviceCount('smartthings'), 1);
});

test('controlDevice forwards changes to the platform and mirrors bridge state', async () => {
  const app = new HomeLinkApp(baseConfig());
  let received = null;
  const platform = controllablePlatform(
    [lightDevice('l1', 'Lamp')],
    () => ({ power: true, brightness: 40 }),
    (r) => { received = r; },
  );
  app.platforms.set('smartthings:c', platform);
  await app.refreshDevices();

  const key = 'smartthings:l1';
  await app.controlDevice(key, { brightness: 75 });
  assert.equal(received.id, 'l1');
  assert.equal(received.changes.brightness, 75);
  assert.equal(app.bridge.getState(key).brightness, 75); // Home app would see this too
});

test('controlDevice injects current brightness when only color changes (Tuya HSV)', async () => {
  const app = new HomeLinkApp(baseConfig());
  let received = null;
  const platform = controllablePlatform(
    [lightDevice('l2', 'Strip')],
    () => ({ power: true, brightness: 60 }),
    (r) => { received = r; },
  );
  app.platforms.set('smartthings:c', platform);
  await app.refreshDevices();

  await app.controlDevice('smartthings:l2', { hue: 200, saturation: 80 });
  assert.equal(received.changes.hue, 200);
  assert.equal(received.changes.saturation, 80);
  assert.equal(received.changes._currentBrightness, 60);
});

test('controlDevice rejects unknown device and empty changes', async () => {
  const app = new HomeLinkApp(baseConfig());
  const platform = controllablePlatform([lightDevice('l3', 'X')], () => ({}), () => {});
  app.platforms.set('smartthings:c', platform);
  await app.refreshDevices();
  await assert.rejects(() => app.controlDevice('smartthings:nope', { power: true }), /Unknown device/);
  await assert.rejects(() => app.controlDevice('smartthings:l3', { bogus: 1 }), /No supported control/);
});

test('controlScene applies a change only to matching device types', async () => {
  const app = new HomeLinkApp(baseConfig());
  const calls = [];
  const platform = {
    name: 'smartthings', label: 'SmartThings', connId: 'smartthings:c',
    async listDevices() { return [lightDevice('l1', 'Lamp'), stDevice('p1', 'Plug')]; },
    async getState() { return { power: true }; },
    async setState(id, changes) { calls.push({ id, changes }); },
  };
  app.platforms.set('smartthings:c', platform);
  await app.refreshDevices();

  const res = await app.controlScene({ types: ['light'], changes: { power: false } });
  assert.equal(res.total, 1);
  assert.equal(res.ok, 1);
  assert.deepEqual(calls.map((c) => c.id), ['l1']); // plug untouched

  calls.length = 0;
  await app.controlScene({ types: null, changes: { power: false } });
  assert.deepEqual(calls.map((c) => c.id).sort(), ['l1', 'p1']); // all devices
});

test('setDeviceTimer schedules an auto-off, reports it, and fires', async (t) => {
  const app = new HomeLinkApp(baseConfig());
  const calls = [];
  const platform = controllablePlatform([lightDevice('l1', 'Lamp')], () => ({ power: true }), (r) => calls.push(r));
  app.platforms.set('smartthings:c', platform);
  await app.refreshDevices();
  const key = 'smartthings:l1';

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { firesAt } = app.setDeviceTimer(key, 30);
  assert.ok(firesAt > Date.now());
  assert.equal(app.allDevices().find((d) => d.key === key).timerFiresAt, firesAt);

  t.mock.timers.tick(30 * 60 * 1000 + 5);
  assert.deepEqual(calls.at(-1).changes, { power: false }); // auto-off fired
});

test('setDeviceTimer cancels with 0 and rejects unknown devices', async () => {
  const app = new HomeLinkApp(baseConfig());
  const platform = controllablePlatform([lightDevice('l1', 'Lamp')], () => ({}), () => {});
  app.platforms.set('smartthings:c', platform);
  await app.refreshDevices();
  const key = 'smartthings:l1';
  app.setDeviceTimer(key, 30);
  assert.equal(app.setDeviceTimer(key, 0).firesAt, null);
  assert.equal(app.allDevices().find((d) => d.key === key).timerFiresAt, null);
  assert.throws(() => app.setDeviceTimer('smartthings:nope', 30), /Unknown device/);
});

test('legacy single-account config migrates into smartthingsAccounts', () => {
  const config = baseConfig();
  delete config.smartthingsAccounts;
  config.smartthings = { token: 'legacy-tok' };
  const app = new HomeLinkApp(config);
  const status = app.status();
  assert.equal(status.platforms.smartthings.accounts.length, 1);
  assert.equal(status.platforms.smartthings.accounts[0].method, 'token');
  assert.equal(config.smartthings, null); // migrated away
  assert.equal(config.smartthingsAccounts.length, 1);
});
