import { getClient } from './adb-client.js';

async function shellCmd(serial, cmd) {
  const device = getClient().getDevice(serial);
  const stream = await device.shell(cmd);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').replace(/\r/g, '').trim();
}

export async function getDeviceInfo(serial) {
  const [model, brand, androidVersion, sdkVersion, screenSize, density, batteryDump] =
    await Promise.all([
      shellCmd(serial, 'getprop ro.product.model'),
      shellCmd(serial, 'getprop ro.product.brand'),
      shellCmd(serial, 'getprop ro.build.version.release'),
      shellCmd(serial, 'getprop ro.build.version.sdk'),
      shellCmd(serial, 'wm size'),
      shellCmd(serial, 'wm density'),
      shellCmd(serial, 'dumpsys battery'),
    ]);

  // Parse screen size: "Physical size: 1080x1920"
  const sizeMatch = screenSize.match(/(\d+)x(\d+)/);
  const width = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  const height = sizeMatch ? parseInt(sizeMatch[2], 10) : 0;

  // Parse density: "Physical density: 480"
  const densityMatch = density.match(/(\d+)/);
  const dpi = densityMatch ? parseInt(densityMatch[1], 10) : 0;

  // Parse battery level and status
  const levelMatch = batteryDump.match(/level:\s*(\d+)/);
  const statusMatch = batteryDump.match(/status:\s*(\d+)/);
  const batteryLevel = levelMatch ? parseInt(levelMatch[1], 10) : -1;
  // status: 2=charging, 3=discharging, 5=full
  const batteryStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const charging = batteryStatus === 2 || batteryStatus === 5;

  return {
    serial,
    model,
    brand,
    androidVersion,
    sdkVersion: parseInt(sdkVersion, 10),
    width,
    height,
    dpi,
    batteryLevel,
    charging,
  };
}

export async function getScreenResolution(serial) {
  const output = await shellCmd(serial, 'wm size');
  const match = output.match(/(\d+)x(\d+)/);
  if (!match) throw new Error('Could not determine screen resolution');
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}
