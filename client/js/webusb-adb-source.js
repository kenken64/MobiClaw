import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';

const APP_NAME = 'MobiClaw';
const DEFAULT_FRAME_INTERVAL_MS = 650;

const KEYS = {
  back: 4,
  backspace: 67,
  delete: 67,
  enter: 66,
  home: 3,
  menu: 82,
  power: 26,
  recent: 187,
  recents: 187,
  search: 84,
  tab: 61,
  'vol down': 25,
  'vol up': 24,
  'volume down': 25,
  'volume up': 24,
};

const APPS = {
  browser: 'com.android.chrome',
  calculator: 'com.google.android.calculator',
  calendar: 'com.google.android.calendar',
  camera: 'com.google.android.GoogleCamera',
  chrome: 'com.android.chrome',
  contacts: 'com.google.android.contacts',
  discord: 'com.discord',
  facebook: 'com.facebook.katana',
  files: 'com.google.android.documentsui',
  gmail: 'com.google.android.gm',
  instagram: 'com.instagram.android',
  maps: 'com.google.android.apps.maps',
  messages: 'com.google.android.apps.messaging',
  phone: 'com.google.android.dialer',
  photos: 'com.google.android.apps.photos',
  play: 'com.android.vending',
  'play store': 'com.android.vending',
  settings: 'com.android.settings',
  slack: 'com.Slack',
  spotify: 'com.spotify.music',
  telegram: 'org.telegram.messenger',
  tiktok: 'com.zhiliaoapp.musically',
  whatsapp: 'com.whatsapp',
  x: 'com.twitter.android',
  youtube: 'com.google.android.youtube',
};

export class WebUsbAdbBridge {
  constructor() {
    this.adb = null;
    this.device = null;
    this.info = null;
    this._streaming = false;
    this._frameTimer = null;
    this._fpsTimer = null;
    this._frameCount = 0;
    this._commandQueue = Promise.resolve();
    this.onDisconnect = null;
  }

  get supported() {
    return Boolean(globalThis.isSecureContext && globalThis.navigator?.usb && AdbDaemonWebUsbDeviceManager.BROWSER);
  }

  get connected() {
    return Boolean(this.adb);
  }

  get serial() {
    return this.info?.serial ?? this.device?.serial ?? '';
  }

  async connect() {
    if (!this.supported) {
      throw new Error('WebUSB ADB requires Chrome/Edge on HTTPS or localhost.');
    }

    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    const device = await manager.requestDevice();

    if (!device) {
      throw new Error('No USB ADB device was selected.');
    }

    const connection = await device.connect();
    const transport = await AdbDaemonTransport.authenticate({
      connection,
      credentialStore: new AdbWebCredentialStore(APP_NAME),
      serial: device.serial,
    });

    this.device = device;
    this.adb = new Adb(transport);
    this.info = await this.getDeviceInfo();

    const connectedAdb = this.adb;
    this.adb.disconnected
      .then(() => {
        if (this.adb !== connectedAdb) {
          return;
        }
        this.stopScreenStream();
        this.adb = null;
        this.device = null;
        this.info = null;
        this.onDisconnect?.();
      })
      .catch(() => {});

    return this.info;
  }

  async disconnect() {
    this.stopScreenStream();
    if (this.adb) {
      await this.adb.close();
    }
    this.adb = null;
    this.device = null;
    this.info = null;
  }

  async getDeviceInfo() {
    this._assertConnected();
    const [model, brand, androidVersion, sdkVersion, sizeOutput, densityOutput, batteryOutput] = await Promise.all([
      this.getProp('ro.product.model'),
      this.getProp('ro.product.brand'),
      this.getProp('ro.build.version.release'),
      this.getProp('ro.build.version.sdk'),
      this.shellText('wm size'),
      this.shellText('wm density'),
      this.shellText('dumpsys battery'),
    ]);

    const sizeMatch = sizeOutput.match(/(?:Physical|Override) size:\s*(\d+)x(\d+)/i);
    const densityMatch = densityOutput.match(/(?:Physical|Override) density:\s*(\d+)/i);
    const levelMatch = batteryOutput.match(/level:\s*(\d+)/i);
    const statusMatch = batteryOutput.match(/status:\s*(\d+)/i);
    const status = Number(statusMatch?.[1] ?? 0);

    this.info = {
      androidVersion: androidVersion || '--',
      batteryLevel: Number(levelMatch?.[1] ?? 0),
      brand: brand || '--',
      charging: status === 2 || status === 5,
      dpi: Number(densityMatch?.[1] ?? 0),
      model: model || this.device?.name || 'Android device',
      sdkVersion: sdkVersion || '--',
      serial: this.device?.serial || this.adb.serial,
      transport: 'webusb',
      width: Number(sizeMatch?.[1] ?? 0),
      height: Number(sizeMatch?.[2] ?? 0),
    };

    return this.info;
  }

  getProp(name) {
    this._assertConnected();
    return this.adb.getProp(name);
  }

  shellText(command) {
    this._assertConnected();
    return this._enqueueCommand(async () => {
      const socket = await this.adb.createSocket(`shell:${command}`);
      return streamToString(socket.readable);
    });
  }

  async capturePng() {
    this._assertConnected();
    const socket = await this.adb.createSocket('exec:screencap -p');
    const bytes = await streamToBytes(socket.readable);

    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
      throw new Error('WebUSB screencap did not return a valid PNG frame.');
    }

    return bytes;
  }

  startScreenStream({ intervalMs = DEFAULT_FRAME_INTERVAL_MS, onFrame, onFps, onError } = {}) {
    this._assertConnected();
    this.stopScreenStream();
    this._streaming = true;
    this._frameCount = 0;
    this._fpsTimer = setInterval(() => {
      onFps?.(this._frameCount);
      this._frameCount = 0;
    }, 1000);

    const loop = async () => {
      while (this._streaming) {
        const startedAt = Date.now();

        try {
          const png = await this.capturePng();
          this._frameCount += 1;
          onFrame?.(png);
        } catch (err) {
          if (this._streaming) {
            onError?.(err);
            await sleep(900);
          }
        }

        const elapsed = Date.now() - startedAt;
        await sleep(Math.max(0, intervalMs - elapsed));
      }
    };

    this._frameTimer = loop();
  }

  stopScreenStream() {
    this._streaming = false;
    if (this._fpsTimer) {
      clearInterval(this._fpsTimer);
      this._fpsTimer = null;
    }
    this._frameTimer = null;
  }

  async handleInputMessage(message) {
    if (!message) {
      return;
    }

    if (message.type === 'key') {
      await this.key(message.keycode);
      return;
    }

    if (message.type === 'scroll') {
      const direction = Number(message.vScroll) < 0 ? 'down' : 'up';
      await this.swipeDirection(direction);
      return;
    }

    if (message.type !== 'touch') {
      return;
    }

    switch (message.action) {
      case 'tap':
        await this.tapNormalized(message.x, message.y);
        break;
      case 'swipe':
        await this.swipeNormalized(message.x1, message.y1, message.x2, message.y2, message.duration || 300);
        break;
      default:
        break;
    }
  }

  async key(keycode) {
    await this.shellText(`input keyevent ${Number(keycode)}`);
  }

  async tapNormalized(nx, ny) {
    const { width, height } = await this._screenSize();
    const x = Math.round(clamp01(nx) * width);
    const y = Math.round(clamp01(ny) * height);
    await this.shellText(`input tap ${x} ${y}`);
  }

  async swipeNormalized(nx1, ny1, nx2, ny2, duration = 300) {
    const { width, height } = await this._screenSize();
    const x1 = Math.round(clamp01(nx1) * width);
    const y1 = Math.round(clamp01(ny1) * height);
    const x2 = Math.round(clamp01(nx2) * width);
    const y2 = Math.round(clamp01(ny2) * height);
    await this.shellText(`input swipe ${x1} ${y1} ${x2} ${y2} ${Math.max(1, Number(duration) || 300)}`);
  }

  async swipeDirection(direction) {
    const { width, height } = await this._screenSize();
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    const marginX = Math.round(width * 0.2);
    const marginY = Math.round(height * 0.2);
    const coords = {
      down: [cx, marginY, cx, height - marginY],
      left: [width - marginX, cy, marginX, cy],
      right: [marginX, cy, width - marginX, cy],
      up: [cx, height - marginY, cx, marginY],
    }[direction] ?? [cx, height - marginY, cx, marginY];

    await this.shellText(`input swipe ${coords.join(' ')} 350`);
  }

  async runDirectCommand(rawPrompt) {
    const original = String(rawPrompt ?? '').trim();
    const input = original.replace(/^\/+/, '').trim();
    const lower = input.toLowerCase();

    if (!input || lower === 'help' || lower === '?') {
      return {
        message: `WebUSB commands:
- /open [app]
- /type [text]
- /tap [x] [y] or /tap center
- /swipe up/down/left/right
- /press home/back/recent/power/volume up/volume down
- /screenshot
- /shell [command]
- /list apps`
      };
    }

    if (KEYS[lower] !== undefined) {
      await this.key(KEYS[lower]);
      return { message: `Pressed ${lower}` };
    }

    const pressMatch = lower.match(/^(?:press|hit|push)\s+(.+)$/);
    if (pressMatch) {
      const key = pressMatch[1].trim();
      if (KEYS[key] === undefined) {
        return { error: true, message: `Unknown key: ${key}` };
      }
      await this.key(KEYS[key]);
      return { message: `Pressed ${key}` };
    }

    const openMatch = lower.match(/^(?:open|launch|start|run)\s+(.+)$/);
    if (openMatch) {
      const appName = openMatch[1].trim();
      const pkg = APPS[appName];
      if (pkg) {
        await this.shellText(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        return { message: `Opened ${appName}` };
      }

      const output = await this.shellText(`pm list packages | grep -i ${shellSingleQuote(appName)}`);
      const packages = output.split('\n').map((line) => line.replace('package:', '').trim()).filter(Boolean);

      if (packages.length === 1) {
        await this.shellText(`monkey -p ${packages[0]} -c android.intent.category.LAUNCHER 1`);
        return { message: `Opened ${packages[0]}` };
      }

      return { error: true, message: packages.length ? `Multiple matches:\n${packages.join('\n')}` : `Unknown app: ${appName}` };
    }

    const typeMatch = original.match(/^\/?(?:type|enter|input|write)\s+(.+)$/i);
    if (typeMatch) {
      const text = typeMatch[1];
      await this.shellText(`input text "${escapeInputText(text)}"`);
      return { message: `Typed: "${text}"` };
    }

    const tapMatch = lower.match(/^tap\s+(\d+)\s+(\d+)$/);
    if (tapMatch) {
      await this.shellText(`input tap ${Number(tapMatch[1])} ${Number(tapMatch[2])}`);
      return { message: `Tapped at (${tapMatch[1]}, ${tapMatch[2]})` };
    }

    if (/^tap\s+(center|middle)$/.test(lower)) {
      await this.tapNormalized(0.5, 0.5);
      return { message: 'Tapped center' };
    }

    const swipeMatch = lower.match(/^(?:swipe|scroll)\s+(up|down|left|right)$/);
    if (swipeMatch) {
      await this.swipeDirection(swipeMatch[1]);
      return { message: `${swipeMatch[0].startsWith('scroll') ? 'Scrolled' : 'Swiped'} ${swipeMatch[1]}` };
    }

    if (/^(?:take\s+)?screenshot$/.test(lower)) {
      return {
        message: 'Screenshot captured from WebUSB.',
        png: await this.capturePng()
      };
    }

    const shellMatch = original.match(/^\/?(?:shell|adb|run)\s+(.+)$/i);
    if (shellMatch) {
      const output = await this.shellText(shellMatch[1]);
      return { message: output || '(no output)' };
    }

    if (/^list\s+apps$/.test(lower) || lower === 'installed apps') {
      const output = await this.shellText('pm list packages -3');
      const apps = output.split('\n').map((line) => line.replace('package:', '').trim()).filter(Boolean).sort();
      return { message: `Installed apps (${apps.length}):\n${apps.join('\n')}` };
    }

    return {
      error: true,
      message: 'WebUSB mode supports direct slash commands and manual control. Use /help for available commands.'
    };
  }

  _assertConnected() {
    if (!this.adb) {
      throw new Error('No WebUSB ADB device is connected.');
    }
  }

  async _screenSize() {
    if (!this.info?.width || !this.info?.height) {
      await this.getDeviceInfo();
    }

    return {
      height: this.info?.height || 1920,
      width: this.info?.width || 1080,
    };
  }

  _enqueueCommand(task) {
    const run = this._commandQueue.then(task, task);
    this._commandQueue = run.catch(() => {});
    return run;
  }
}

async function streamToBytes(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

async function streamToString(readable) {
  return new TextDecoder().decode(await streamToBytes(readable));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function escapeInputText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/ /g, '%s')
    .replace(/([`$!&|;(){}<>])/g, '\\$1');
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
