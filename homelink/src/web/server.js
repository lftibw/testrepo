/**
 * Web setup portal: connect platform accounts, see devices, and get the
 * HomeKit pairing QR code / PIN.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createWebServer(app /* HomeLinkApp */) {
  const web = express();
  web.use(express.json());
  web.use(express.static(path.join(__dirname, 'public')));

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[homelink] ${req.method} ${req.path} failed:`, err.message);
      res.status(400).json({ error: err.message });
    });

  web.get('/api/status', wrap(async (req, res) => {
    const status = app.status();
    if (status.bridge.setupURI) {
      status.bridge.qr = await QRCode.toDataURL(status.bridge.setupURI, { margin: 1, width: 240 });
    }
    res.json(status);
  }));

  web.post('/api/smartthings', wrap(async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    const label = String(req.body?.label ?? '').trim();
    if (!token) throw new Error('A SmartThings personal access token is required');
    const deviceCount = await app.connectSmartThings({ token, label });
    res.json({ ok: true, deviceCount });
  }));

  // The redirect URI must exactly match what the user registered on their
  // OAuth app; derive it from how the portal is actually being reached.
  const callbackUri = (req) => `${req.protocol}://${req.get('host')}/api/smartthings/callback`;

  web.get('/api/smartthings/redirect-uri', wrap(async (req, res) => {
    res.json({ redirectUri: callbackUri(req) });
  }));

  web.post('/api/smartthings/oauth/start', wrap(async (req, res) => {
    const clientId = String(req.body?.clientId ?? '').trim();
    const clientSecret = String(req.body?.clientSecret ?? '').trim();
    const label = String(req.body?.label ?? '').trim();
    const authorizeUrl = app.startSmartThingsOAuth({ clientId, clientSecret, label, redirectUri: callbackUri(req) });
    res.json({ ok: true, authorizeUrl });
  }));

  web.get('/api/smartthings/callback', async (req, res) => {
    const done = (title, body, ok) => res.status(ok ? 200 : 400).send(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><body style="font:16px/1.5 -apple-system,sans-serif;max-width:460px;margin:80px auto;padding:0 20px;text-align:center;color:${ok ? '#0a7d33' : '#c0392b'}">` +
      `<h2>${ok ? '✓' : '⚠️'} ${title}</h2><p style="color:#333">${body}</p>` +
      (ok ? `<script>setTimeout(()=>window.close(),2500)</script>` : '') + `</body>`
    );
    try {
      if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
      const code = String(req.query.code ?? '');
      const state = String(req.query.state ?? '');
      if (!code) throw new Error('No authorization code returned');
      const deviceCount = await app.completeSmartThingsOAuth({ code, state });
      done('SmartThings connected', `Found ${deviceCount} device(s). You can close this tab and return to HomeLink.`, true);
    } catch (err) {
      console.error('[homelink] SmartThings OAuth callback failed:', err.message);
      done('Authorization failed', err.message, false);
    }
  });

  web.post('/api/tuya', wrap(async (req, res) => {
    const accessId = String(req.body?.accessId ?? '').trim();
    const accessSecret = String(req.body?.accessSecret ?? '').trim();
    const region = String(req.body?.region ?? 'in').trim();
    if (!accessId || !accessSecret) throw new Error('Tuya Access ID and Access Secret are required');
    const deviceCount = await app.connectTuya({ accessId, accessSecret, region });
    res.json({ ok: true, deviceCount });
  }));

  web.post('/api/smartlife/qr', wrap(async (req, res) => {
    const userCode = String(req.body?.userCode ?? '').trim();
    if (!userCode) throw new Error('Enter your Smart Life user code (app → Me → Settings → Account and Security)');
    const { qrContent } = await app.startSmartLifeLogin(userCode);
    res.json({ ok: true, qr: await QRCode.toDataURL(qrContent, { margin: 1, width: 220 }) });
  }));

  web.post('/api/smartlife/poll', wrap(async (req, res) => {
    res.json(await app.pollSmartLifeLogin());
  }));

  web.delete('/api/platform/:connId', wrap(async (req, res) => {
    const connId = req.params.connId;
    const known = connId === 'tuya' || connId === 'smartlife' || connId.startsWith('smartthings:');
    if (!known) throw new Error('Unknown platform');
    app.disconnectPlatform(connId);
    res.json({ ok: true });
  }));

  web.get('/api/devices', wrap(async (req, res) => {
    res.json({ devices: app.allDevices() });
  }));

  web.post('/api/devices/refresh', wrap(async (req, res) => {
    await app.refreshDevices();
    res.json({ ok: true, devices: app.allDevices() });
  }));

  web.post('/api/devices/:key/excluded', wrap(async (req, res) => {
    app.setDeviceExcluded(req.params.key, !!req.body?.excluded);
    res.json({ ok: true });
  }));

  return web;
}
