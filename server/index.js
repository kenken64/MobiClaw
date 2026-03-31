import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import { listDevices, trackDevices } from './adb/adb-client.js';
import { createWsHandler } from './ws/ws-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// Serve static frontend files
app.use(express.static(join(__dirname, '..', 'client')));

// REST API for initial page load
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await listDevices();
    res.json(devices.map(d => ({ serial: d.id, type: d.type })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket handler
createWsHandler(server);

// Track device connections
trackDevices((event, device) => {
  console.log(`[ADB] Device ${event}: ${device.id} (${device.type})`);
});

server.listen(config.port, () => {
  console.log(`\n  MobiClaw`);
  console.log(`  ────────`);
  console.log(`  Server:  http://localhost:${config.port}`);
  console.log(`  ADB:     Waiting for devices...\n`);

  // List connected devices on startup
  listDevices().then(devices => {
    if (devices.length === 0) {
      console.log('  No devices connected. Connect a device via USB or adb connect <ip>');
    } else {
      devices.forEach(d => console.log(`  Found device: ${d.id}`));
    }
    console.log('');
  }).catch(err => {
    console.error('  [Error] ADB not found or not running.');
    console.error('  Make sure ADB is installed and in your PATH.');
    console.error(`  Details: ${err.message}\n`);
  });
});
