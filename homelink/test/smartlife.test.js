import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  SmartLifePlatform,
  aesGcmEncrypt,
  aesGcmDecrypt,
  deriveSecret,
  restfulSign,
  pollLogin,
} from '../src/platforms/smartlife.js';

test('AES-GCM encdata round-trips (SDK format: b64(nonce)+b64(ct+tag))', () => {
  const secret = '0123456789abcdef';
  const enc = aesGcmEncrypt('{"homeId":"42"}', secret);
  assert.equal(aesGcmDecrypt(enc, secret), '{"homeId":"42"}');
  // nonce is 12 bytes → its base64 is exactly 16 chars with no padding,
  // which is what makes the SDK's concatenated-base64 format decodable
  assert.equal(Buffer.from(enc.slice(0, 16), 'base64').length, 12);
});

test('secret derivation and sign string match the SDK algorithm', () => {
  const rid = 'a5f8c1e2-1234-5678-9abc-def012345678';
  const hashKey = crypto.createHash('md5').update(rid + 'refresh-token-x').digest('hex');
  const secret = deriveSecret(rid, hashKey);
  assert.equal(secret.length, 16);
  assert.equal(secret, crypto.createHmac('sha256', rid).update(hashKey).digest('hex').slice(0, 16));

  const headers = { 'X-appKey': 'app', 'X-requestId': rid, 'X-sid': '', 'X-time': '1700', 'X-token': 'tok' };
  const sign = restfulSign(hashKey, 'QQ', 'BB', headers);
  const expectedStr = `X-appKey=app||X-requestId=${rid}||X-time=1700||X-token=tok` + 'QQ' + 'BB';
  assert.equal(sign, crypto.createHmac('sha256', hashKey).update(expectedStr).digest('hex'));
});

test('pollLogin reports pending until approved, then returns credentials', async (t) => {
  let approved = false;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => approved
      ? { success: true, t: 1700, result: {
          endpoint: 'https://apigw.tuyaeu.com', terminal_id: 'term1', uid: 'u1',
          expire_time: 7200, access_token: 'at', refresh_token: 'rt',
        } }
      : { success: false, code: 1, msg: 'not scanned' },
  }));
  assert.equal((await pollLogin('tok', 'uc')).pending, true);
  approved = true;
  const result = await pollLogin('tok', 'uc');
  assert.equal(result.pending, false);
  assert.equal(result.credentials.endpoint, 'https://apigw.tuyaeu.com');
  assert.equal(result.credentials.tokenInfo.accessToken, 'at');
});

/**
 * Mock Smart Life server: verifies the request signature the way Tuya does,
 * decrypts query encdata, and encrypts the response result — so this test
 * proves both directions of the crypto and the header signing.
 */
function mockSmartLifeServer(routes, refreshToken) {
  return async (url, options = {}) => {
    const u = new URL(url);
    const headers = options.headers ?? {};
    const rid = headers['X-requestId'];
    const hashKey = crypto.createHash('md5').update(rid + refreshToken).digest('hex');
    const secret = deriveSecret(rid, hashKey);

    // verify signature exactly like the server would
    const expectedSign = restfulSign(
      hashKey,
      u.searchParams.get('encdata') ?? '',
      options.body ? JSON.parse(options.body).encdata : '',
      headers,
    );
    assert.equal(headers['X-sign'], expectedSign, 'request signature must verify');

    let query = null;
    if (u.searchParams.get('encdata')) {
      query = JSON.parse(aesGcmDecrypt(u.searchParams.get('encdata'), secret));
    }
    let body = null;
    if (options.body) {
      body = JSON.parse(aesGcmDecrypt(JSON.parse(options.body).encdata, secret));
    }

    const handler = routes[`${(options.method || 'GET').toUpperCase()} ${u.pathname}`];
    if (!handler) throw new Error(`unmocked: ${u.pathname}`);
    const result = typeof handler === 'function' ? handler(query, body) : handler;
    return {
      ok: true,
      json: async () => ({ success: true, t: Date.now(), result: aesGcmEncrypt(JSON.stringify(result), secret) }),
    };
  };
}

const CREDS = {
  userCode: 'uc1',
  endpoint: 'https://apigw.tuyaeu.com',
  terminalId: 'term1',
  tokenInfo: { t: Date.now(), uid: 'u1', expireTime: 7200, accessToken: 'at', refreshToken: 'rt' },
};

test('SmartLifePlatform lists Wipro devices through the encrypted API', async (t) => {
  const platform = new SmartLifePlatform(structuredClone(CREDS));
  let commandsSent = null;
  t.mock.method(globalThis, 'fetch', mockSmartLifeServer({
    'GET /v1.0/m/life/users/homes': [{ ownerId: 99, name: 'Home' }],
    'GET /v1.0/m/life/ha/home/devices': (query) => {
      assert.deepEqual(query, { homeId: '99' });
      return [{
        id: 'wb1', name: 'Hall Light', product_name: 'Wipro 9W CCT', category: 'dj', online: true,
        status: [
          { code: 'switch_led', value: true },
          { code: 'bright_value_v2', value: 505 },
          { code: 'temp_value_v2', value: 0 },
        ],
      }];
    },
    'GET /v1.1/m/life/wb1/specifications': {
      functions: [
        { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000}' },
        { code: 'temp_value_v2', type: 'Integer', values: '{"min":0,"max":1000}' },
      ],
      status: [],
    },
    'GET /v1.0/m/life/ha/devices/detail': (query) => {
      assert.deepEqual(query, { devIds: 'wb1' });
      return [{ id: 'wb1', status: [{ code: 'switch_led', value: true }, { code: 'bright_value_v2', value: 1000 }] }];
    },
    'POST /v1.1/m/thing/wb1/commands': (query, body) => {
      commandsSent = body.commands;
      return true;
    },
  }, 'rt'));

  const devices = await platform.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].type, 'light');
  assert.equal(devices[0].name, 'Hall Light');
  assert.equal(devices[0].features.brightness, true);
  assert.equal(devices[0].features.colorTemp !== null, true);

  const state = await platform.getState('wb1', devices[0]);
  assert.equal(state.power, true);
  assert.equal(state.brightness, 100);

  await platform.setState('wb1', { brightness: 50 }, devices[0]);
  assert.deepEqual(commandsSent, [{ code: 'bright_value_v2', value: 505 }]);
});
