const grid = document.getElementById('grid');
const toastEl = document.getElementById('toast');

const AC_MODE_LABELS = { auto: 'Auto', cool: 'Cool', heat: 'Heat', dry: 'Dry', wind: 'Fan', fanOnly: 'Fan', fan: 'Fan' };

// hue/saturation presets for color bulbs
const PRESET_COLORS = [
  { name: 'Warm', h: 30, s: 55 }, { name: 'White', h: 0, s: 0 }, { name: 'Red', h: 0, s: 100 },
  { name: 'Orange', h: 30, s: 100 }, { name: 'Green', h: 120, s: 90 }, { name: 'Cyan', h: 180, s: 85 },
  { name: 'Blue', h: 220, s: 95 }, { name: 'Purple', h: 280, s: 85 }, { name: 'Pink', h: 320, s: 70 },
];
const TIMER_PRESETS = [15, 30, 60];

let filter = 'all';        // 'all' | 'light' | 'outlet' | 'switch' | 'ac'
let lastDevices = [];

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function control(key, changes) {
  cooldown.set(key, Date.now());
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(key)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Control failed');
  } catch (err) {
    toast(err.message);
  }
}

// --- HSV <-> hex helpers (hue 0-360, sat 0-100; value fixed full for swatch) ---
function hsvToHex(h, s) {
  s /= 100; const v = 1;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hx = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}
function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : Math.round((d / max) * 100);
  return { h, s };
}

const cards = new Map();  // key -> { el, keys }
const cooldown = new Map(); // key -> ts of last local change

function buildCard(d) {
  const el = document.createElement('div');
  el.className = 'dev';
  el.dataset.key = d.key;

  const acct = d.account ? ` · <span class="acct">${escapeHtml(d.account)}</span>` : '';
  const online = d.online === false ? '<span class="offline"> · offline</span>' : '';
  let controls = '';

  if (d.features.ac) {
    const modes = (d.features.ac.modes || []).map((m) =>
      `<button data-mode="${escapeHtml(m)}">${AC_MODE_LABELS[m] || m}</button>`).join('');
    controls = `
      <div class="ctl"><div class="modes" data-role="modes">${modes}</div></div>
      <div class="ctl temp">
        <button data-role="temp-down">−</button>
        <div class="tempval"><div class="t"><span data-role="target">--</span>°</div><div class="cur">now <span data-role="current">--</span>°</div></div>
        <button data-role="temp-up">＋</button>
      </div>`;
    if (d.features.ac.panelLight) {
      controls += `<div class="ctl toggle-row">
        <span class="lbl">Panel light</span>
        <label class="switch"><input type="checkbox" data-role="panel-light"><span></span></label>
      </div>`;
    }
  } else {
    if (d.features.brightness) {
      controls += `<div class="ctl">
        <div class="lbl">Brightness <b data-role="bright-val">--</b></div>
        <input type="range" min="1" max="100" value="100" data-role="bright">
      </div>`;
    }
    if (d.features.colorTemp) {
      controls += `<div class="ctl">
        <div class="lbl">Warmth <b data-role="ct-val">--</b></div>
        <input type="range" min="2700" max="6500" step="100" value="4000" data-role="ct" class="ct-slider">
      </div>`;
    }
    if (d.features.color) {
      controls += `<div class="ctl colorrow"><span class="lbl" style="display:block">Color</span>
        <input type="color" data-role="color" value="#ffaa55"></div>`;
      const swatches = PRESET_COLORS.map((c) =>
        `<span class="sw" title="${c.name}" data-h="${c.h}" data-s="${c.s}" style="background:${hsvToHex(c.h, c.s)}"></span>`).join('');
      controls += `<div class="ctl"><div class="presets" data-role="presets">${swatches}</div></div>`;
    }
    if (!d.features.brightness && !d.features.colorTemp && !d.features.color) {
      controls += `<div class="plain">On / off</div>`;
    }
  }

  // Auto-off timer (every device can be powered off)
  const timerBtns = TIMER_PRESETS.map((m) => `<button class="mini" data-mins="${m}">${m}m</button>`).join('');
  controls += `<div class="ctl"><div class="timerrow" data-role="timer">
    <span data-role="timer-label">Auto-off:</span>${timerBtns}
    <button class="mini" data-mins="0" data-role="timer-cancel" hidden>Cancel</button>
  </div></div>`;

  el.innerHTML = `
    <div class="top">
      <div>
        <div class="nm">${escapeHtml(d.name)}</div>
        <div class="sub">${escapeHtml(d.platformLabel)}${acct}${online}</div>
      </div>
      <button class="pow" data-role="power" title="Power">⏻</button>
    </div>
    <div class="ctrls">${controls}</div>`;

  wireCard(el, d);
  return el;
}

function wireCard(el, d) {
  const key = d.key;
  const q = (role) => el.querySelector(`[data-role="${role}"]`);

  q('power').addEventListener('click', () => {
    const on = !el.classList.contains('poweron');
    setPower(el, on);
    control(key, { power: on });
  });

  const bright = q('bright');
  if (bright) {
    bright.addEventListener('input', () => { q('bright-val').textContent = `${bright.value}%`; });
    bright.addEventListener('change', () => control(key, { brightness: Number(bright.value) }));
  }
  const ct = q('ct');
  if (ct) {
    ct.addEventListener('input', () => { q('ct-val').textContent = `${ct.value}K`; });
    ct.addEventListener('change', () => control(key, { colorTempK: Number(ct.value) }));
  }
  const color = q('color');
  if (color) {
    color.addEventListener('change', () => {
      const { h, s } = hexToHsv(color.value);
      control(key, { hue: h, saturation: s });
    });
  }
  const modes = q('modes');
  if (modes) {
    modes.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        modes.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        control(key, { mode: b.dataset.mode, power: true });
        setPower(el, true);
      });
    });
  }
  const presets = q('presets');
  if (presets) {
    presets.querySelectorAll('.sw').forEach((sw) => {
      sw.addEventListener('click', () => {
        control(key, { hue: Number(sw.dataset.h), saturation: Number(sw.dataset.s) });
        const color = q('color');
        if (color) color.value = hsvToHex(Number(sw.dataset.h), Number(sw.dataset.s));
      });
    });
  }
  const timer = q('timer');
  if (timer) {
    timer.querySelectorAll('button[data-mins]').forEach((b) => {
      b.addEventListener('click', async () => {
        const minutes = Number(b.dataset.mins);
        cooldown.set(key, Date.now());
        try {
          const res = await fetch(`/api/devices/${encodeURIComponent(key)}/timer`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ minutes }),
          });
          const data = await res.json();
          setTimer(el, data.firesAt);
        } catch { toast('Could not set timer'); }
      });
    });
  }

  const panel = q('panel-light');
  if (panel) {
    panel.addEventListener('change', () => control(key, { panelLight: panel.checked }));
  }

  const down = q('temp-down'), up = q('temp-up');
  if (down && up) {
    const step = (delta) => {
      const t = q('target');
      const min = d.features.ac.minC ?? 16, max = d.features.ac.maxC ?? 30;
      let v = Number(t.textContent);
      if (!Number.isFinite(v)) v = Math.round((min + max) / 2);
      v = Math.max(min, Math.min(max, v + delta));
      t.textContent = v;
      control(key, { targetC: v, power: true });
      setPower(el, true);
    };
    down.addEventListener('click', () => step(-1));
    up.addEventListener('click', () => step(1));
  }
}

function setPower(el, on) {
  el.classList.toggle('poweron', on);
  el.classList.toggle('off', !on);
  const p = el.querySelector('[data-role="power"]');
  if (p) p.classList.toggle('on', on);
}

function setTimer(el, firesAt) {
  el.dataset.firesAt = firesAt || '';
  renderTimer(el);
}

function renderTimer(el) {
  const label = el.querySelector('[data-role="timer-label"]');
  const cancel = el.querySelector('[data-role="timer-cancel"]');
  const presets = el.querySelectorAll('[data-role="timer"] button[data-mins]:not([data-role="timer-cancel"])');
  if (!label) return;
  const firesAt = Number(el.dataset.firesAt);
  if (firesAt && firesAt > Date.now()) {
    const secs = Math.round((firesAt - Date.now()) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    label.innerHTML = `<span class="active">Off in ${mm}:${ss}</span>`;
    presets.forEach((b) => (b.hidden = true));
    if (cancel) cancel.hidden = false;
  } else {
    label.textContent = 'Auto-off:';
    presets.forEach((b) => (b.hidden = false));
    if (cancel) cancel.hidden = true;
  }
}

// Tick down any visible auto-off countdowns once a second.
setInterval(() => {
  for (const el of cards.values()) if (el.dataset.firesAt) renderTimer(el);
}, 1000);

async function scene(types, changes, label) {
  try {
    const res = await fetch('/api/scene', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types, changes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scene failed');
    toast(`${label}: ${data.ok}/${data.total} devices`);
    for (const el of cards.values()) cooldown.set(el.dataset.key, Date.now());
    setTimeout(load, 600);
  } catch (err) { toast(err.message); }
}

function renderChrome(devices) {
  const lights = devices.filter((d) => d.type === 'light');
  const onCount = devices.filter((d) => d.state.power).length;
  const litLights = lights.filter((d) => d.state.power).length;
  const parts = [`<b>${onCount}</b> of <b>${devices.length}</b> devices on`];
  if (lights.length) parts.push(`<b>${litLights}</b> of <b>${lights.length}</b> lights lit`);
  document.getElementById('summary').innerHTML = parts.join(' · ');

  const types = [...new Set(devices.map((d) => d.type))];
  const order = ['light', 'outlet', 'switch', 'ac'];
  const label = { light: 'Lights', outlet: 'Plugs', switch: 'Switches', ac: 'ACs' };
  const chips = ['all', ...order.filter((t) => types.includes(t))];
  const fl = document.getElementById('filters');
  fl.innerHTML = chips.map((t) =>
    `<span class="chip ${filter === t ? 'active' : ''}" data-filter="${t}">${t === 'all' ? 'All' : label[t]}</span>`).join('');
  fl.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    filter = c.dataset.filter;
    fl.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === c));
    applyFilter();
  }));
}

function applyFilter() {
  for (const [key, el] of cards) {
    const d = lastDevices.find((x) => x.key === key);
    el.style.display = (!d || filter === 'all' || d.type === filter) ? '' : 'none';
  }
}

function updateCard(el, d) {
  if (Date.now() - (cooldown.get(d.key) || 0) < 2500) return; // don't fight a just-made change
  const q = (role) => el.querySelector(`[data-role="${role}"]`);
  const s = d.state || {};
  const active = document.activeElement;

  if (s.power !== undefined) setPower(el, !!s.power);

  const bright = q('bright');
  if (bright && s.brightness !== undefined && bright !== active) {
    bright.value = s.brightness; q('bright-val').textContent = `${s.brightness}%`;
  }
  const ct = q('ct');
  if (ct && s.colorTempK && ct !== active) {
    ct.value = s.colorTempK; q('ct-val').textContent = `${s.colorTempK}K`;
  }
  const color = q('color');
  if (color && s.hue !== undefined && color !== active) {
    color.value = hsvToHex(s.hue, s.saturation ?? 100);
  }
  const modes = q('modes');
  if (modes && s.mode) {
    modes.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
  }
  if (q('target') && s.targetC !== undefined) q('target').textContent = Math.round(s.targetC);
  if (q('current') && s.currentC !== undefined) q('current').textContent = Math.round(s.currentC);
  const panel = q('panel-light');
  if (panel && s.panelLight !== undefined && panel !== active) panel.checked = !!s.panelLight;

  if (String(d.timerFiresAt || '') !== (el.dataset.firesAt || '')) setTimer(el, d.timerFiresAt);
}

async function load() {
  let devices;
  try {
    const res = await fetch('/api/devices');
    ({ devices } = await res.json());
  } catch {
    return;
  }
  lastDevices = devices;
  document.getElementById('filters').style.display = devices.length ? '' : 'none';
  if (!devices.length) {
    grid.innerHTML = '<div class="empty">No devices yet — connect a platform in <a href="/">Setup</a>.</div>';
    document.getElementById('summary').textContent = 'No devices connected';
    cards.clear();
    return;
  }
  const wantKeys = devices.map((d) => d.key).join('|');
  if (grid.dataset.keys !== wantKeys) {
    grid.innerHTML = '';
    cards.clear();
    for (const d of devices) {
      const el = buildCard(d);
      cards.set(d.key, el);
      grid.appendChild(el);
    }
    grid.dataset.keys = wantKeys;
  }
  for (const d of devices) {
    const el = cards.get(d.key);
    if (el) updateCard(el, d);
  }
  renderChrome(devices);
  applyFilter();
}

document.getElementById('all-lights-on').addEventListener('click', () => scene(['light'], { power: true }, 'Lights on'));
document.getElementById('all-lights-off').addEventListener('click', () => scene(['light'], { power: false }, 'Lights off'));
document.getElementById('all-off').addEventListener('click', () => scene(null, { power: false }, 'Everything off'));
document.getElementById('refresh').addEventListener('click', load);

load();
setInterval(load, 4000);
