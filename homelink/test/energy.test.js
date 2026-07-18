import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWatts, computeEnergy } from '../src/energy.js';

const light = (extra = {}) => ({ type: 'light', features: { brightness: true }, ...extra });
const ac = () => ({ type: 'ac', features: { ac: {} } });
const plug = () => ({ type: 'outlet', features: {} });

test('estimateWatts scales a bulb by brightness and zeroes when off', () => {
  assert.equal(estimateWatts(light(), { power: true, brightness: 100 }), 10);
  assert.equal(estimateWatts(light(), { power: true, brightness: 50 }), 5);
  assert.equal(estimateWatts(light(), { power: false }), 0);
  assert.equal(estimateWatts(light(), {}), null); // unknown on/off
});

test('estimateWatts gives AC ballparks by mode', () => {
  assert.equal(estimateWatts(ac(), { power: true, mode: 'cool' }), 1200);
  assert.equal(estimateWatts(ac(), { power: true, mode: 'cool', optionalMode: 'speed' }), 1700); // Max
  assert.equal(estimateWatts(ac(), { power: true, mode: 'fan' }), 120);
});

test('estimateWatts returns null for an unmetered plug/switch', () => {
  assert.equal(estimateWatts(plug(), { power: true }), null);
});

test('computeEnergy prefers a real measurement and computes cost', () => {
  const rate = { currency: '₹', pricePerKwh: 8 };
  const measured = computeEnergy(plug(), { power: true, watts: 2000, energyKwh: 4.5 }, rate);
  assert.equal(measured.watts, 2000);
  assert.equal(measured.estimated, false);
  assert.equal(measured.kwh, 4.5);
  assert.equal(measured.costPerHour, 16); // 2kW * ₹8
  assert.equal(measured.costPerDay, 384); // *24

  const estimated = computeEnergy(light(), { power: true, brightness: 100 }, rate);
  assert.equal(estimated.watts, 10);
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.costPerHour, 0.08);
});

test('computeEnergy reports null cost for unknown draw', () => {
  const e = computeEnergy(plug(), { power: true }, { currency: '$', pricePerKwh: 0.15 });
  assert.equal(e.watts, null);
  assert.equal(e.costPerHour, null);
});
