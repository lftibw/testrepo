/**
 * Shared Tuya data-point (DP) mapping used by both connection methods:
 * the OpenAPI cloud project (tuya.js) and the Smart Life app login
 * (smartlife.js). Wipro devices speak the same DP codes either way.
 */

export const POWER_CODES = ['switch_led', 'switch', 'switch_1'];

// dj = light, dc = string light, dd = strip, xdd = ceiling light, fwd = ambience
const LIGHT_CATEGORIES = new Set(['dj', 'dc', 'dd', 'xdd', 'fwd', 'gyd', 'tyndj']);
const OUTLET_CATEGORIES = new Set(['cz', 'pc', 'kg']);

export function pickPowerCode(codes) {
  return POWER_CODES.find((c) => codes.has(c));
}

export function classifyType(category, powerCode) {
  if (powerCode === 'switch_led' || LIGHT_CATEGORIES.has(category)) return 'light';
  if (OUTLET_CATEGORIES.has(category)) return category === 'kg' ? 'switch' : 'outlet';
  return 'switch';
}

/**
 * Builds the feature flags plus the `_tuya` control mapping for a device,
 * given its DP codes and (optionally) its specification ranges.
 * `specRange(code)` returns {min,max} or null when specs are unavailable.
 */
export function buildMapping(codes, category, specRange = () => null) {
  const powerCode = pickPowerCode(codes);
  if (!powerCode) return null;

  const brightCode = ['bright_value_v2', 'bright_value'].find((c) => codes.has(c));
  const tempCode = ['temp_value_v2', 'temp_value'].find((c) => codes.has(c));
  const colorCode = ['colour_data_v2', 'colour_data'].find((c) => codes.has(c));

  return {
    type: classifyType(category, powerCode),
    features: {
      power: true,
      brightness: !!brightCode,
      colorTemp: tempCode ? { minK: 2700, maxK: 6500 } : null,
      color: !!colorCode,
    },
    _tuya: {
      powerCode,
      brightCode,
      brightRange: specRange(brightCode) ?? { min: 10, max: 1000 },
      tempCode,
      tempRange: specRange(tempCode) ?? { min: 0, max: 1000 },
      colorCode,
      colorIsV2: colorCode === 'colour_data_v2',
    },
  };
}

export function toPercent(value, range) {
  const clamped = Math.max(range.min, Math.min(range.max, Number(value) || 0));
  return Math.round(((clamped - range.min) / (range.max - range.min)) * 100);
}

export function fromPercent(pct, range) {
  const p = Math.max(0, Math.min(100, pct));
  return Math.round(range.min + (p / 100) * (range.max - range.min));
}

/** Converts a {code: value} DP map into the normalized state shape. */
export function dpToState(dp, mapping) {
  const m = mapping;
  const state = {};
  if (m.powerCode in dp) state.power = !!dp[m.powerCode];

  const workMode = dp.work_mode; // 'white' | 'colour' | scenes
  if (m.brightCode && m.brightCode in dp) {
    state.brightness = toPercent(dp[m.brightCode], m.brightRange);
  }
  if (m.tempCode && m.tempCode in dp) {
    // Tuya temp scale: min = warm (2700K), max = cool (6500K)
    const pct = toPercent(dp[m.tempCode], m.tempRange);
    state.colorTempK = Math.round(2700 + (pct / 100) * (6500 - 2700));
  }
  if (m.colorCode && dp[m.colorCode]) {
    try {
      const c = typeof dp[m.colorCode] === 'string' ? JSON.parse(dp[m.colorCode]) : dp[m.colorCode];
      const sMax = m.colorIsV2 ? 1000 : 255;
      const vMax = m.colorIsV2 ? 1000 : 255;
      state.hue = Number(c.h) || 0;
      state.saturation = Math.round(((Number(c.s) || 0) / sMax) * 100);
      if (workMode === 'colour') {
        state.brightness = Math.round(((Number(c.v) || 0) / vMax) * 100);
      }
    } catch { /* unexpected colour_data payload */ }
  }
  return state;
}

/** Converts normalized state changes into Tuya command list [{code, value}]. */
export function stateToCommands(changes, mapping) {
  const m = mapping;
  const commands = [];
  if (changes.power !== undefined) {
    commands.push({ code: m.powerCode, value: !!changes.power });
  }
  if ((changes.hue !== undefined || changes.saturation !== undefined) && m.colorCode) {
    const sMax = m.colorIsV2 ? 1000 : 255;
    const vMax = m.colorIsV2 ? 1000 : 255;
    const brightness = changes.brightness ?? changes._currentBrightness ?? 100;
    commands.push({ code: 'work_mode', value: 'colour' });
    commands.push({
      code: m.colorCode,
      value: {
        h: Math.round(Math.max(0, Math.min(360, changes.hue ?? 0))),
        s: Math.round(((changes.saturation ?? 100) / 100) * sMax),
        v: Math.round((brightness / 100) * vMax),
      },
    });
  } else {
    if (changes.colorTempK !== undefined && m.tempCode) {
      const pct = ((changes.colorTempK - 2700) / (6500 - 2700)) * 100;
      commands.push({ code: 'work_mode', value: 'white' });
      commands.push({ code: m.tempCode, value: fromPercent(pct, m.tempRange) });
    }
    if (changes.brightness !== undefined && m.brightCode) {
      commands.push({ code: m.brightCode, value: fromPercent(changes.brightness, m.brightRange) });
    }
  }
  return commands;
}
