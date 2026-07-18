import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnergyTracker } from '../src/energy-tracker.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'homelink-energy-'));
}

const HOUR = 3_600_000;

test('integrates estimated power over time into kWh', () => {
  const t = new EnergyTracker(tmpDir());
  const t0 = 1_000_000_000_000;
  t.sample([{ key: 'ac', watts: 1000 }], t0);            // baseline, no elapsed time yet
  assert.equal(t.total('ac').kwh, 0);
  t.sample([{ key: 'ac', watts: 1000 }], t0 + HOUR);     // 1000W for 1h = 1 kWh
  assert.equal(t.total('ac').kwh, 1);
  t.sample([{ key: 'ac', watts: 2000 }], t0 + 2 * HOUR); // +2000W for 1h = +2 kWh
  assert.equal(t.total('ac').kwh, 3);
});

test('uses the device meter delta when available and ignores resets', () => {
  const t = new EnergyTracker(tmpDir());
  const t0 = 1_000_000_000_000;
  t.sample([{ key: 'plug', energyKwh: 100 }], t0);       // baseline reading
  assert.equal(t.total('plug').kwh, 0);
  t.sample([{ key: 'plug', energyKwh: 104.5 }], t0 + HOUR); // +4.5 kWh
  assert.equal(t.total('plug').kwh, 4.5);
  t.sample([{ key: 'plug', energyKwh: 2 }], t0 + 2 * HOUR); // meter reset — skip negative delta
  assert.equal(t.total('plug').kwh, 4.5);
  t.sample([{ key: 'plug', energyKwh: 3 }], t0 + 3 * HOUR); // resumes from the new baseline (+1)
  assert.equal(t.total('plug').kwh, 5.5);
});

test('off / unknown devices do not accumulate', () => {
  const t = new EnergyTracker(tmpDir());
  const t0 = 1_000_000_000_000;
  t.sample([{ key: 'x', watts: 0 }], t0);
  t.sample([{ key: 'x', watts: 0 }], t0 + HOUR);
  assert.equal(t.total('x').kwh, 0);
  t.sample([{ key: 'y', watts: null }], t0);
  t.sample([{ key: 'y', watts: null }], t0 + HOUR);
  assert.equal(t.total('y').kwh, 0);
});

test('persists totals across restarts and resets on demand', () => {
  const dir = tmpDir();
  const t0 = 1_000_000_000_000;
  const a = new EnergyTracker(dir);
  a.sample([{ key: 'ac', watts: 1000 }], t0);
  a.sample([{ key: 'ac', watts: 1000 }], t0 + 2 * HOUR); // 2 kWh
  // reset() saves synchronously, flushing 'ac' to disk too
  a.reset('other', t0);

  const b = new EnergyTracker(dir); // "restart"
  assert.equal(b.total('ac').kwh, 2);
  b.reset('ac', t0 + 3 * HOUR);
  assert.equal(b.total('ac').kwh, 0);
  assert.equal(b.total('ac').since, t0 + 3 * HOUR);
});
