import test from 'node:test';
import assert from 'node:assert/strict';
import { tuyaSign, TuyaPlatform } from '../src/platforms/tuya.js';

test('tuyaSign produces uppercase hex HMAC and sorted query URL', () => {
  const { sign, url } = tuyaSign({
    clientId: 'client123',
    secret: 'secret456',
    accessToken: 'tok',
    t: '1700000000000',
    nonce: 'nonce-1',
    method: 'get',
    path: '/v1.0/devices',
    query: { size: '100', last_row_key: 'abc' },
    body: '',
  });
  assert.match(sign, /^[0-9A-F]{64}$/);
  assert.equal(url, '/v1.0/devices?last_row_key=abc&size=100');
});

test('tuyaSign is deterministic for identical input', () => {
  const input = {
    clientId: 'a', secret: 'b', accessToken: '', t: '1', nonce: 'n',
    method: 'POST', path: '/v1.0/devices/x/commands', body: '{"commands":[]}',
  };
  assert.equal(tuyaSign(input).sign, tuyaSign(input).sign);
});

function mockFetch(routes) {
  return async (url, options = {}) => {
    const u = new URL(url);
    const key = `${(options.method || 'GET').toUpperCase()} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unmocked request: ${key}`);
    const result = typeof handler === 'function' ? handler(u, options) : handler;
    return { ok: true, json: async () => ({ success: true, result }) };
  };
}

const TOKEN_RESULT = { access_token: 'at', refresh_token: 'rt', expire_time: 7200, uid: 'u1' };

test('TuyaPlatform maps Wipro bulb state to normalized values', async (t) => {
  const platform = new TuyaPlatform({ accessId: 'id', accessSecret: 'sec', region: 'in' });
  t.mock.method(globalThis, 'fetch', mockFetch({
    'GET /v1.0/token': TOKEN_RESULT,
    'GET /v1.0/devices/dev1/status': [
      { code: 'switch_led', value: true },
      { code: 'work_mode', value: 'white' },
      { code: 'bright_value_v2', value: 505 }, // midpoint of 10-1000
      { code: 'temp_value_v2', value: 1000 }, // coolest
    ],
  }));

  const device = {
    _tuya: {
      powerCode: 'switch_led',
      brightCode: 'bright_value_v2', brightRange: { min: 10, max: 1000 },
      tempCode: 'temp_value_v2', tempRange: { min: 0, max: 1000 },
      colorCode: null, colorIsV2: true,
    },
  };
  const state = await platform.getState('dev1', device);
  assert.equal(state.power, true);
  assert.equal(state.brightness, 50);
  assert.equal(state.colorTempK, 6500);
});

test('TuyaPlatform falls back to v2 endpoints when legacy list returns server error', async (t) => {
  const platform = new TuyaPlatform({ accessId: 'id', accessSecret: 'sec', region: 'eu' });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const u = new URL(url);
    const key = `${(options.method || 'GET').toUpperCase()} ${u.pathname}`;
    if (key === 'GET /v1.0/token') {
      return { ok: true, json: async () => ({ success: true, result: TOKEN_RESULT }) };
    }
    if (key === 'GET /v1.0/iot-01/associated-users/devices') {
      // what new platform.tuya.com projects return on the legacy endpoint
      return { ok: true, json: async () => ({ success: false, code: 500, msg: 'server error' }) };
    }
    if (key === 'GET /v2.0/cloud/thing/device') {
      return { ok: true, json: async () => ({ success: true, result: [
        { id: 'w1', custom_name: 'Bedroom Light', product_name: 'Wipro 9W', category: 'dj', is_online: true },
      ] }) };
    }
    if (key === 'GET /v1.0/devices/w1/status') {
      return { ok: true, json: async () => ({ success: true, result: [
        { code: 'switch_led', value: true },
        { code: 'bright_value_v2', value: 1000 },
      ] }) };
    }
    if (key === 'GET /v1.0/devices/w1/specifications') {
      return { ok: true, json: async () => ({ success: false, code: 500, msg: 'server error' }) };
    }
    throw new Error(`unmocked request: ${key}`);
  });

  const devices = await platform.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Bedroom Light');
  assert.equal(devices[0].type, 'light');
  assert.equal(devices[0].features.brightness, true);
});

test('Tuya errors carry actionable hints', async (t) => {
  const platform = new TuyaPlatform({ accessId: 'id', accessSecret: 'bad', region: 'eu' });
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ success: false, code: 1004, msg: 'sign invalid' }),
  }));
  await assert.rejects(() => platform.testConnection(), /Access Secret is wrong/);
});

test('TuyaPlatform sends scaled commands', async (t) => {
  const platform = new TuyaPlatform({ accessId: 'id', accessSecret: 'sec', region: 'in' });
  let sentBody = null;
  t.mock.method(globalThis, 'fetch', mockFetch({
    'GET /v1.0/token': TOKEN_RESULT,
    'POST /v1.0/devices/dev1/commands': (u, options) => {
      sentBody = JSON.parse(options.body);
      return true;
    },
  }));

  const device = {
    _tuya: {
      powerCode: 'switch_led',
      brightCode: 'bright_value_v2', brightRange: { min: 10, max: 1000 },
      tempCode: 'temp_value_v2', tempRange: { min: 0, max: 1000 },
      colorCode: 'colour_data_v2', colorIsV2: true,
    },
  };
  await platform.setState('dev1', { power: true, brightness: 100 }, device);
  assert.deepEqual(sentBody.commands, [
    { code: 'switch_led', value: true },
    { code: 'bright_value_v2', value: 1000 },
  ]);

  await platform.setState('dev1', { hue: 120, saturation: 50, _currentBrightness: 80 }, device);
  const colorCmd = sentBody.commands.find((c) => c.code === 'colour_data_v2');
  assert.deepEqual(colorCmd.value, { h: 120, s: 500, v: 800 });
  assert.ok(sentBody.commands.some((c) => c.code === 'work_mode' && c.value === 'colour'));
});
