const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setMsg(id, text, ok) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : '');
}

function renderPlatform(prefix, info, connectedText) {
  $(`${prefix}-dot`).className = 'dot ' + (info.connected ? 'on' : info.error ? 'err' : '');
  $(`${prefix}-form`).hidden = info.connected;
  $(`${prefix}-connected`).hidden = !info.connected;
  if (info.connected) $(`${prefix}-summary`).textContent = connectedText;
  if (info.error) setMsg(`${prefix}-msg`, info.error, false);
}

async function loadStatus() {
  const status = await api('/api/status');
  const b = status.bridge;
  $('pin').textContent = b.pincode;
  if (b.qr) {
    $('qr').src = b.qr;
    $('qr').hidden = false;
  }
  $('paired-msg').textContent = b.paired ? '✓ Paired with Apple Home' : 'Not paired yet';
  $('paired-msg').className = 'msg ' + (b.paired ? 'ok' : '');

  const st = status.platforms.smartthings;
  $('st-dot').className = 'dot ' + (st.connected ? 'on' : st.error ? 'err' : '');
  const stForms = !st.connected;
  $('st-tabs').hidden = !stForms;
  $('st-oauth-pane').hidden = !stForms || stTab !== 'oauth';
  $('st-pat-pane').hidden = !stForms || stTab !== 'pat';
  $('st-connected').hidden = !st.connected;
  if (st.connected) {
    const how = st.method === 'oauth' ? 'auto-refreshing OAuth — never expires' : 'personal token — expires in 24h';
    $('st-summary').textContent = `Connected (${how}) — ${st.deviceCount} device(s) found`;
  }
  if (st.error) setMsg('st-msg', st.error, false);

  renderPlatform('tuya', status.platforms.tuya,
    `Connected (${status.platforms.tuya.region.toUpperCase()} region) — ${status.platforms.tuya.deviceCount} device(s) found`);

  const sl = status.platforms.smartlife;
  $('sl-form').hidden = sl.connected;
  $('sl-connected').hidden = !sl.connected;
  if (sl.connected) $('sl-summary').textContent = `Connected via Smart Life — ${sl.deviceCount} device(s) found`;
  if (sl.error) setMsg('sl-msg', sl.error, false);
  // one dot for the whole Wipro card: green if either method is connected
  $('tuya-dot').className = 'dot ' + ((sl.connected || status.platforms.tuya.connected) ? 'on'
    : (sl.error || status.platforms.tuya.error) ? 'err' : '');
}

const FEATURE_LABELS = [
  ['brightness', 'dimming'],
  ['colorTemp', 'white temp'],
  ['color', 'color'],
  ['ac', 'temp + mode'],
];

function describeState(d) {
  if (d.state.power === undefined) return '—';
  if (!d.state.power) return 'Off';
  let s = 'On';
  if (d.features.brightness && d.state.brightness !== undefined) s += ` · ${d.state.brightness}%`;
  if (d.features.ac) {
    if (d.state.mode) s += ` · ${d.state.mode}`;
    if (d.state.targetC !== undefined) s += ` · set ${d.state.targetC.toFixed(1)}°C`;
    if (d.state.currentC !== undefined) s += ` (now ${d.state.currentC.toFixed(1)}°C)`;
  }
  return s;
}

async function loadDevices() {
  const { devices } = await api('/api/devices');
  const wrap = $('devices');
  if (!devices.length) {
    wrap.innerHTML = '<div class="empty">No devices yet — connect a platform above.</div>';
    return;
  }
  const rows = devices.map((d) => `
    <tr>
      <td><strong>${escapeHtml(d.name)}</strong><br><span style="color:var(--muted);font-size:12px">${escapeHtml(d.model || '')}</span></td>
      <td><span class="badge ${d.platform === 'smartthings' ? 'st' : 'tuya'}">${escapeHtml(d.platformLabel)}</span></td>
      <td>${escapeHtml(d.type)}</td>
      <td>${FEATURE_LABELS.filter(([k]) => d.features[k]).map(([, l]) => `<span class="chip">${l}</span>`).join('') || '<span class="chip">on/off</span>'}</td>
      <td>${describeState(d)}</td>
      <td>
        <label class="switch" title="Expose to HomeKit">
          <input type="checkbox" data-key="${escapeHtml(d.key)}" ${d.excluded ? '' : 'checked'}>
          <span></span>
        </label>
      </td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Device</th><th>Platform</th><th>Type</th><th>Features</th><th>State</th><th>In HomeKit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
  wrap.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      await api(`/api/devices/${encodeURIComponent(cb.dataset.key)}/excluded`, {
        method: 'POST',
        body: JSON.stringify({ excluded: !cb.checked }),
      }).catch((err) => alert(err.message));
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadDevices()]);
}

// SmartThings method tabs (OAuth vs quick token)
let stTab = 'oauth';
document.querySelectorAll('#st-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    stTab = tab.dataset.tab;
    document.querySelectorAll('#st-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('st-oauth-pane').hidden = stTab !== 'oauth';
    $('st-pat-pane').hidden = stTab !== 'pat';
  });
});

// Show the exact redirect URI the user must register on their OAuth app
api('/api/smartthings/redirect-uri').then(({ redirectUri }) => {
  $('st-redirect-uri').textContent = redirectUri;
}).catch(() => {});

let stOAuthPoll = null;

$('st-oauth-connect').addEventListener('click', async () => {
  const btn = $('st-oauth-connect');
  btn.disabled = true;
  setMsg('st-msg', 'Opening SmartThings authorization…', true);
  try {
    const { authorizeUrl } = await api('/api/smartthings/oauth/start', {
      method: 'POST',
      body: JSON.stringify({
        clientId: $('st-client-id').value.trim(),
        clientSecret: $('st-client-secret').value.trim(),
      }),
    });
    window.open(authorizeUrl, '_blank', 'noopener');
    setMsg('st-msg', 'Approve in the SmartThings tab that opened, then this will connect automatically…', true);
    // The callback connects server-side; poll status until it lands.
    clearInterval(stOAuthPoll);
    const startedAt = Date.now();
    stOAuthPoll = setInterval(async () => {
      const status = await api('/api/status');
      if (status.platforms.smartthings.connected) {
        clearInterval(stOAuthPoll);
        setMsg('st-msg', 'Connected! Auto-refresh is on — this stays linked permanently.', true);
        await refreshAll();
      } else if (Date.now() - startedAt > 5 * 60_000) {
        clearInterval(stOAuthPoll);
        setMsg('st-msg', 'Timed out waiting for authorization. Try again.', false);
      }
    }, 2500);
  } catch (err) {
    setMsg('st-msg', err.message, false);
  } finally {
    btn.disabled = false;
  }
});

$('st-connect').addEventListener('click', async () => {
  const btn = $('st-connect');
  btn.disabled = true;
  setMsg('st-msg', 'Connecting…', true);
  try {
    const { deviceCount } = await api('/api/smartthings', {
      method: 'POST',
      body: JSON.stringify({ token: $('st-token').value }),
    });
    setMsg('st-msg', `Connected! Found ${deviceCount} device(s).`, true);
    await refreshAll();
  } catch (err) {
    setMsg('st-msg', err.message, false);
  } finally {
    btn.disabled = false;
  }
});

$('tuya-connect').addEventListener('click', async () => {
  const btn = $('tuya-connect');
  btn.disabled = true;
  setMsg('tuya-msg', 'Connecting…', true);
  try {
    const { deviceCount } = await api('/api/tuya', {
      method: 'POST',
      body: JSON.stringify({
        accessId: $('tuya-id').value,
        accessSecret: $('tuya-secret').value,
        region: $('tuya-region').value,
      }),
    });
    setMsg('tuya-msg', `Connected! Found ${deviceCount} device(s).`, true);
    await refreshAll();
  } catch (err) {
    setMsg('tuya-msg', err.message, false);
  } finally {
    btn.disabled = false;
  }
});

$('st-disconnect').addEventListener('click', async () => {
  await api('/api/platform/smartthings', { method: 'DELETE' });
  setMsg('st-msg', '', true);
  await refreshAll();
});

$('tuya-disconnect').addEventListener('click', async () => {
  await api('/api/platform/tuya', { method: 'DELETE' });
  setMsg('tuya-msg', '', true);
  await refreshAll();
});

// Wipro card method tabs
document.querySelectorAll('#wipro-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#wipro-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('sl-pane').hidden = tab.dataset.tab !== 'sl';
    $('dev-pane').hidden = tab.dataset.tab !== 'dev';
  });
});

let slPollTimer = null;

$('sl-connect').addEventListener('click', async () => {
  const btn = $('sl-connect');
  btn.disabled = true;
  setMsg('sl-msg', '', true);
  clearInterval(slPollTimer);
  try {
    const { qr } = await api('/api/smartlife/qr', {
      method: 'POST',
      body: JSON.stringify({ userCode: $('sl-usercode').value }),
    });
    $('sl-qr').src = qr;
    $('sl-qr-wrap').hidden = false;
    const startedAt = Date.now();
    slPollTimer = setInterval(async () => {
      try {
        const result = await api('/api/smartlife/poll', { method: 'POST' });
        if (!result.pending) {
          clearInterval(slPollTimer);
          $('sl-qr-wrap').hidden = true;
          setMsg('sl-msg', `Connected! Found ${result.deviceCount} device(s).`, true);
          await refreshAll();
        } else if (Date.now() - startedAt > 3 * 60_000) {
          clearInterval(slPollTimer);
          $('sl-qr-wrap').hidden = true;
          setMsg('sl-msg', 'QR code expired — tap the button for a fresh one.', false);
        }
      } catch (err) {
        clearInterval(slPollTimer);
        $('sl-qr-wrap').hidden = true;
        setMsg('sl-msg', err.message, false);
      }
    }, 2500);
  } catch (err) {
    setMsg('sl-msg', err.message, false);
  } finally {
    btn.disabled = false;
  }
});

$('sl-disconnect').addEventListener('click', async () => {
  await api('/api/platform/smartlife', { method: 'DELETE' });
  setMsg('sl-msg', '', true);
  await refreshAll();
});

$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  try {
    await api('/api/devices/refresh', { method: 'POST' });
    await refreshAll();
  } finally {
    $('refresh').disabled = false;
  }
});

refreshAll();
setInterval(refreshAll, 15000);
