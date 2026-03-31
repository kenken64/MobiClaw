import { getClient } from '../adb/adb-client.js';
import { getScreenResolution } from '../adb/device-info.js';

export class ShellInputHandler {
  constructor(serial) {
    this.serial = serial;
    this.resolution = null;
    this._busy = false;
    this._queue = [];
  }

  async init() {
    this.resolution = await getScreenResolution(this.serial);
  }

  async tap(nx, ny) {
    if (!this.resolution) await this.init();
    const x = Math.round(nx * this.resolution.width);
    const y = Math.round(ny * this.resolution.height);
    await this._exec(`input tap ${x} ${y}`);
  }

  async swipe(nx1, ny1, nx2, ny2, duration = 300) {
    if (!this.resolution) await this.init();
    const x1 = Math.round(nx1 * this.resolution.width);
    const y1 = Math.round(ny1 * this.resolution.height);
    const x2 = Math.round(nx2 * this.resolution.width);
    const y2 = Math.round(ny2 * this.resolution.height);
    await this._exec(`input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`);
  }

  async key(keycode) {
    await this._exec(`input keyevent ${keycode}`);
  }

  async text(str) {
    // Escape special shell characters
    const escaped = str.replace(/(['"\\$`!])/g, '\\$1').replace(/ /g, '%s');
    await this._exec(`input text "${escaped}"`);
  }

  async _exec(cmd) {
    // Simple queue to avoid overloading the device with concurrent input commands
    if (this._busy) {
      // Drop intermediate commands if queue is full (keep responsiveness)
      if (this._queue.length > 2) {
        this._queue.shift();
      }
      return new Promise((resolve) => {
        this._queue.push({ cmd, resolve });
      });
    }

    this._busy = true;
    try {
      await this._shell(cmd);
    } finally {
      this._busy = false;
      if (this._queue.length > 0) {
        const next = this._queue.shift();
        this._exec(next.cmd).then(next.resolve);
      }
    }
  }

  async _shell(cmd) {
    const device = getClient().getDevice(this.serial);
    const stream = await device.shell(cmd);
    // Consume the stream to let the command finish
    for await (const _ of stream) { /* drain */ }
  }
}
