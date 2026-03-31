import { getClient } from '../adb/adb-client.js';
import config from '../config.js';

export class ScreencapProvider {
  constructor(serial) {
    this.serial = serial;
    this.running = false;
    this.frameCallback = null;
    this.interval = Math.floor(1000 / config.targetFps);
    this.frameCount = 0;
    this.fps = 0;
    this._fpsTimer = null;
  }

  onFrame(callback) {
    this.frameCallback = callback;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.frameCount = 0;
    this.fps = 0;

    // FPS counter
    this._fpsTimer = setInterval(() => {
      this.fps = this.frameCount;
      this.frameCount = 0;
    }, 1000);

    this._captureLoop();
  }

  stop() {
    this.running = false;
    if (this._fpsTimer) {
      clearInterval(this._fpsTimer);
      this._fpsTimer = null;
    }
  }

  async _captureLoop() {
    while (this.running) {
      const start = Date.now();
      try {
        const frame = await this._captureFrame();
        if (frame && this.frameCallback) {
          this.frameCallback(frame);
          this.frameCount++;
        }
      } catch (err) {
        if (!this.running) break;
        console.error('[Screencap] Capture error:', err.message);
        // Brief pause on error to avoid tight error loops
        await sleep(500);
        continue;
      }

      // Adaptive timing: subtract capture duration from interval
      const elapsed = Date.now() - start;
      const delay = Math.max(0, this.interval - elapsed);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  async _captureFrame() {
    const device = getClient().getDevice(this.serial);
    // exec-out gives raw binary without \r\n translation
    const stream = await device.shell('exec-out screencap -p');
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Validate PNG signature (first 4 bytes: 0x89 P N G)
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
      return null;
    }
    return buffer;
  }

  getInfo() {
    return { type: 'png', fps: this.fps };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
