/**
 * Energy + cost estimation for a device.
 *
 * Prefers a real measurement when the device reports one (state.watts from a
 * SmartThings powerMeter / Tuya cur_power; state.energyKwh from an energyMeter).
 * Otherwise falls back to a rough estimate from the device type and state,
 * clearly flagged as estimated so the UI can show "~".
 */

/** Rough live power draw (Watts) when a device has no real meter. */
export function estimateWatts(device, state) {
  if (state.power === false) return 0;
  if (state.power !== true) return null; // unknown on/off → unknown draw

  const type = device.type;
  const features = device.features ?? {};

  if (type === 'light') {
    const maxW = 10; // a typical LED smart bulb at full brightness
    const brightness = features.brightness ? (state.brightness ?? 100) : 100;
    return Math.max(1, Math.round((maxW * brightness) / 100));
  }
  if (type === 'ac') {
    // Compressor load varies a lot; give a sensible ballpark by mode.
    if (state.optionalMode === 'speed') return 1700; // Max/turbo
    if (state.mode === 'wind' || state.mode === 'fan') return 120; // fan only
    if (state.mode === 'dry') return 700;
    return 1200; // cool/heat/auto
  }
  // Outlets and switches drive an unknown external load — can't guess without a meter.
  return null;
}

/**
 * @param rate { currency, pricePerKwh }
 * @returns { watts, estimated, currency, kwh, costPerHour, costPerDay }
 */
export function computeEnergy(device, state = {}, rate = {}) {
  const measured = typeof state.watts === 'number' && state.watts >= 0 ? Math.round(state.watts) : null;
  let watts = measured;
  let estimated = false;
  if (watts == null) {
    watts = estimateWatts(device, state);
    estimated = watts != null;
  }
  const currency = rate.currency ?? '';
  const price = Number(rate.pricePerKwh) || 0;
  const kwh = typeof state.energyKwh === 'number' ? state.energyKwh : null;

  const out = { watts, estimated, currency, kwh };
  if (watts != null) {
    out.costPerHour = Number(((watts / 1000) * price).toFixed(3));
    out.costPerDay = Number(((watts / 1000) * price * 24).toFixed(2));
  } else {
    out.costPerHour = null;
    out.costPerDay = null;
  }
  return out;
}
