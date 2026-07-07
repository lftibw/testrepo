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
    if (!token) throw new Error('A SmartThings personal access token is required');
    const deviceCount = await app.connectSmartThings({ token });
    res.json({ ok: true, deviceCount });
  }));

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

  web.delete('/api/platform/:name', wrap(async (req, res) => {
    const { name } = req.params;
    if (!['smartthings', 'tuya', 'smartlife'].includes(name)) throw new Error('Unknown platform');
    app.disconnectPlatform(name);
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
