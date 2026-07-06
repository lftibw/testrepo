import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.HOMELINK_DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function randomMac() {
  const bytes = crypto.randomBytes(6);
  // Locally administered, unicast address
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  return [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function randomPin() {
  // HomeKit pincode format XXX-XX-XXX; avoid trivially weak codes
  let digits;
  do {
    digits = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  } while (/^(\d)\1{7}$/.test(digits) || digits === '12345678' || digits === '87654321');
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

const DEFAULTS = () => ({
  bridge: {
    name: 'HomeLink Bridge',
    username: randomMac(),
    pincode: randomPin(),
    port: 51826,
  },
  webPort: 8580,
  smartthings: null, // { token }
  tuya: null, // { accessId, accessSecret, region }
  excludedDevices: [], // ["smartthings:<id>", "tuya:<id>"]
});

export function dataDir() {
  return DATA_DIR;
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let config = DEFAULTS();
  if (fs.existsSync(CONFIG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...saved, bridge: { ...config.bridge, ...saved.bridge } };
  }
  saveConfig(config);
  return config;
}

export function saveConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
