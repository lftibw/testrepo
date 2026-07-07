import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartThingsPlatform } from '../src/platforms/smartthings.js';

function mockFetch(routes) {
  return async (url, options = {}) => {
    const u = new URL(url);
    const key = `${(options.method || 'GET').toUpperCase()} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unmocked request: ${key}`);
    const result = typeof handler === 'function' ? handler(u, options) : handler;
    return { ok: true, json: async () => result };
  };
}

const COLOR_BULB = {
  deviceId: 'st-bulb-1',
  label: 'Living Room Bulb',
  name: 'c2c-rgbw-color-bulb',
  deviceTypeName: 'RGBW Bulb',
  components: [{
    id: 'main',
    categories: [{ name: 'Light' }],
    capabilities: [
      { id: 'switch' }, { id: 'switchLevel' }, { id: 'colorControl' }, { id: 'colorTemperature' },
    ],
  }],
};

const PLAIN_SENSOR = {
  deviceId: 'st-sensor-1',
  label: 'Door Sensor',
  components: [{ id: 'main', categories: [], capabilities: [{ id: 'contactSensor' }] }],
};

test('listDevices normalizes color bulbs and skips non-actuators', async (t) => {
  const platform = new SmartThingsPlatform({ token: 'tok' });
  t.mock.method(globalThis, 'fetch', mockFetch({
    'GET /v1/devices': { items: [COLOR_BULB, PLAIN_SENSOR] },
  }));
  const devices = await platform.listDevices();
  assert.equal(devices.length, 1);
  const bulb = devices[0];
  assert.equal(bulb.id, 'st-bulb-1');
  assert.equal(bulb.type, 'light');
  assert.equal(bulb.name, 'Living Room Bulb');
  assert.deepEqual(
    { brightness: bulb.features.brightness, color: bulb.features.color, colorTemp: !!bulb.features.colorTemp },
    { brightness: true, color: true, colorTemp: true },
  );
});

test('getState converts SmartThings 0-100 hue to HomeKit 0-360', async (t) => {
  const platform = new SmartThingsPlatform({ token: 'tok' });
  t.mock.method(globalThis, 'fetch', mockFetch({
    'GET /v1/devices/st-bulb-1/status': {
      components: {
        main: {
          switch: { switch: { value: 'on' } },
          switchLevel: { level: { value: 75 } },
          colorControl: { hue: { value: 50 }, saturation: { value: 40 } },
          colorTemperature: { colorTemperature: { value: 3000 } },
        },
      },
    },
  }));
  const state = await platform.getState('st-bulb-1');
  assert.equal(state.power, true);
  assert.equal(state.brightness, 75);
  assert.equal(state.hue, 180); // 50 * 3.6
  assert.equal(state.saturation, 40);
  assert.equal(state.colorTempK, 3000);
});

const AC_DEVICE = {
  deviceId: 'st-ac-1',
  label: 'Bedroom AC',
  deviceTypeName: 'Samsung Room A/C',
  components: [{
    id: 'main',
    categories: [{ name: 'AirConditioner' }],
    capabilities: [
      { id: 'switch' }, { id: 'airConditionerMode' }, { id: 'thermostatCoolingSetpoint' },
      { id: 'temperatureMeasurement' }, { id: 'airConditionerFanMode' },
    ],
  }],
};

const AC_STATUS = {
  components: {
    main: {
      switch: { switch: { value: 'on' } },
      airConditionerMode: {
        airConditionerMode: { value: 'cool' },
        supportedAcModes: { value: ['auto', 'cool', 'dry', 'wind', 'heat'] },
      },
      temperatureMeasurement: { temperature: { value: 27, unit: 'C' } },
      thermostatCoolingSetpoint: { coolingSetpoint: { value: 24, unit: 'C' } },
      'custom.thermostatSetpointControl': {
        minimumSetpoint: { value: 16, unit: 'C' },
        maximumSetpoint: { value: 30, unit: 'C' },
      },
    },
  },
};

test('normalizes an AC into type ac with modes and setpoint limits', async (t) => {
  const platform = new SmartThingsPlatform({ token: 'tok' });
  t.mock.method(globalThis, 'fetch', mockFetch({
    'GET /v1/devices': { items: [AC_DEVICE] },
    'GET /v1/devices/st-ac-1/status': AC_STATUS,
  }));
  const [ac] = await platform.listDevices();
  assert.equal(ac.type, 'ac');
  assert.deepEqual(ac.features.ac.modes, ['auto', 'cool', 'dry', 'wind', 'heat']);
  assert.equal(ac.features.ac.minC, 16);
  assert.equal(ac.features.ac.maxC, 30);
  assert.equal(ac.features.ac.unit, 'C');

  const state = await platform.getState('st-ac-1', ac);
  assert.equal(state.power, true);
  assert.equal(state.mode, 'cool');
  assert.equal(state.currentC, 27);
  assert.equal(state.targetC, 24);
});

test('AC setState sends mode and setpoint commands', async (t) => {
  const platform = new SmartThingsPlatform({ token: 'tok' });
  let sentBody = null;
  t.mock.method(globalThis, 'fetch', mockFetch({
    'POST /v1/devices/st-ac-1/commands': (u, options) => {
      sentBody = JSON.parse(options.body);
      return {};
    },
  }));
  const device = { features: { ac: { modes: ['auto', 'cool', 'heat'], minC: 16, maxC: 30, unit: 'C' } } };
  await platform.setState('st-ac-1', { mode: 'cool', targetC: 23.5 }, device);
  assert.deepEqual(sentBody.commands, [
    { component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] },
    { component: 'main', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [23.5] },
  ]);

  await platform.setState('st-ac-1', { targetC: 24 }, { features: { ac: { unit: 'F' } } });
  assert.deepEqual(sentBody.commands[0].arguments, [75]); // 24°C → 75°F
});

test('setState builds SmartThings command payloads', async (t) => {
  const platform = new SmartThingsPlatform({ token: 'tok' });
  let sentBody = null;
  t.mock.method(globalThis, 'fetch', mockFetch({
    'POST /v1/devices/st-bulb-1/commands': (u, options) => {
      sentBody = JSON.parse(options.body);
      return {};
    },
  }));
  await platform.setState('st-bulb-1', { power: true, brightness: 30, hue: 180, saturation: 40 });
  const capabilities = sentBody.commands.map((c) => `${c.capability}.${c.command}`);
  assert.deepEqual(capabilities, ['switch.on', 'switchLevel.setLevel', 'colorControl.setColor']);
  const color = sentBody.commands.find((c) => c.capability === 'colorControl').arguments[0];
  assert.equal(color.hue, 50); // 180 / 3.6, back to SmartThings scale
  assert.equal(color.saturation, 40);
});
