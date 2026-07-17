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
