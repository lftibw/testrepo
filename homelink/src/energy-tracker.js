/**
 * Accumulates total energy consumption per device over time, persisted to
 * disk so it survives restarts.
 *
 * For metered devices we add the delta of the device's own cumulative kWh
 * counter (accurate). For everything else we integrate the (estimated or
 * measured) power draw over the elapsed time between samples.
 */

import fs from 'node:fs';
import path from 'node:path';

export class EnergyTracker {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'energy.json');
    this.totals = {}; // key -> { kwh, since, lastKwh, lastAt }
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && saved.totals) this.totals = saved.totals;
    } catch { /* first run */ }
    this.saveTimer = null;
  }

  /**
   * @param entries [{ key, watts, energyKwh }] — current draw + optional meter reading
   * @param now epoch millis (injectable for tests)
   */
  sample(entries, now = Date.now()) {
    for (const { key, watts, energyKwh } of entries) {
      const rec = this.totals[key] ?? (this.totals[key] = { kwh: 0, since: now, lastKwh: null, lastAt: now });

      if (typeof energyKwh === 'number') {
        // Device has its own cumulative meter — add the delta since last read.
        if (rec.lastKwh != null && energyKwh >= rec.lastKwh) rec.kwh += energyKwh - rec.lastKwh;
        rec.lastKwh = energyKwh; // (re)baseline; also handles meter resets (delta skipped)
      } else if (typeof watts === 'number' && watts > 0) {
        // Integrate power over the elapsed interval.
        const hours = Math.max(0, (now - rec.lastAt) / 3_600_000);
        rec.kwh += (watts / 1000) * hours;
      }
      rec.lastAt = now;
    }
    this.#scheduleSave();
  }

  total(key) {
    const rec = this.totals[key];
    if (!rec) return { kwh: 0, since: null };
    return { kwh: Math.round(rec.kwh * 1000) / 1000, since: rec.since };
  }

  reset(key, now = Date.now()) {
    const rec = this.totals[key];
    if (rec) { rec.kwh = 0; rec.since = now; }
    else this.totals[key] = { kwh: 0, since: now, lastKwh: null, lastAt: now };
    this.#save();
  }

  #scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.#save(); }, 5000);
    this.saveTimer.unref?.();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, totals: this.totals }));
    } catch (err) {
      console.error('[homelink] failed to save energy totals:', err.message);
    }
  }
}
