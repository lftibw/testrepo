import path from 'node:path';
import { HAPStorage } from '@homebridge/hap-nodejs';
import { loadConfig, dataDir } from './config.js';
import { HomeLinkApp } from './app.js';
import { createWebServer } from './web/server.js';

async function main() {
  const config = loadConfig();
  HAPStorage.setCustomStoragePath(path.join(dataDir(), 'persist'));

  const app = new HomeLinkApp(config);
  await app.start();

  const web = createWebServer(app);
  const port = process.env.HOMELINK_WEB_PORT || config.webPort;
  web.listen(port, () => {
    console.log(`[homelink] setup portal: http://localhost:${port}`);
    console.log(`[homelink] HomeKit PIN:  ${config.bridge.pincode}`);
  });

  const shutdown = async () => {
    console.log('\n[homelink] shutting down…');
    await app.bridge.unpublish().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[homelink] fatal:', err);
  process.exit(1);
});
