/**
 * Scrcpy binary control protocol for touch/key injection.
 * Sends binary messages directly to the scrcpy control socket.
 * Sub-10ms latency vs ~100ms per adb shell input command.
 */

// Control message types
const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TEXT = 1;
const TYPE_INJECT_TOUCH = 2;
const TYPE_INJECT_SCROLL = 3;
const TYPE_SET_SCREEN_POWER_MODE = 10;

// Touch actions (matches Android MotionEvent)
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

// Pointer ID for mouse (-1 as int64)
const POINTER_MOUSE = BigInt(-1);

export class ScrcpyInputHandler {
  constructor(controlSocket, screenWidth, screenHeight) {
    this.socket = controlSocket;
    this.width = screenWidth;
    this.height = screenHeight;
  }

  /** Tap at normalized coordinates (0.0-1.0) */
  tap(nx, ny) {
    const x = Math.round(nx * this.width);
    const y = Math.round(ny * this.height);
    this._injectTouch(ACTION_DOWN, x, y, 0xffff);
    this._injectTouch(ACTION_UP, x, y, 0x0000);
  }

  /** Swipe from (nx1,ny1) to (nx2,ny2) using interpolated move events */
  swipe(nx1, ny1, nx2, ny2, duration = 300) {
    const x1 = Math.round(nx1 * this.width);
    const y1 = Math.round(ny1 * this.height);
    const x2 = Math.round(nx2 * this.width);
    const y2 = Math.round(ny2 * this.height);

    const steps = Math.max(Math.floor(duration / 16), 5); // ~60fps steps

    this._injectTouch(ACTION_DOWN, x1, y1, 0xffff);

    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = Math.round(x1 + (x2 - x1) * t);
      const y = Math.round(y1 + (y2 - y1) * t);
      this._injectTouch(ACTION_MOVE, x, y, 0xffff);
    }

    this._injectTouch(ACTION_UP, x2, y2, 0x0000);
  }

  /** Touch down at normalized coordinates */
  touchDown(nx, ny) {
    const x = Math.round(nx * this.width);
    const y = Math.round(ny * this.height);
    this._injectTouch(ACTION_DOWN, x, y, 0xffff);
  }

  /** Touch move to normalized coordinates */
  touchMove(nx, ny) {
    const x = Math.round(nx * this.width);
    const y = Math.round(ny * this.height);
    this._injectTouch(ACTION_MOVE, x, y, 0xffff);
  }

  /** Touch up at normalized coordinates */
  touchUp(nx, ny) {
    const x = Math.round(nx * this.width);
    const y = Math.round(ny * this.height);
    this._injectTouch(ACTION_UP, x, y, 0x0000);
  }

  /** Send Android keycode event */
  key(keycode) {
    this._injectKeyDown(keycode);
    this._injectKeyUp(keycode);
  }

  /** Inject text (UTF-8) */
  text(str) {
    const textBuf = Buffer.from(str, 'utf-8');
    const buf = Buffer.alloc(1 + 4 + textBuf.length);
    buf[0] = TYPE_INJECT_TEXT;
    buf.writeInt32BE(textBuf.length, 1);
    textBuf.copy(buf, 5);
    this._write(buf);
  }

  /** Inject scroll event at normalized coordinates */
  scroll(nx, ny, hScroll, vScroll) {
    const x = Math.round(nx * this.width);
    const y = Math.round(ny * this.height);

    // Scroll message: type(1) + x(4) + y(4) + w(2) + h(2) + hScroll(4) + vScroll(4) + buttons(4)
    const buf = Buffer.alloc(25);
    let offset = 0;
    buf[offset++] = TYPE_INJECT_SCROLL;
    buf.writeInt32BE(x, offset); offset += 4;
    buf.writeInt32BE(y, offset); offset += 4;
    buf.writeUInt16BE(this.width, offset); offset += 2;
    buf.writeUInt16BE(this.height, offset); offset += 2;
    // hScroll and vScroll are float-like encoded as int32 (value * 65536 in some versions, or raw in others)
    // For scrcpy v2.7, they're int32 representing 16.16 fixed-point
    buf.writeInt32BE(Math.round(hScroll * 65536), offset); offset += 4;
    buf.writeInt32BE(Math.round(vScroll * 65536), offset); offset += 4;
    buf.writeInt32BE(0, offset); // buttons
    this._write(buf);
  }

  /**
   * Inject touch event.
   * Binary format (32 bytes):
   *   type(1) + action(1) + pointerId(8) + x(4) + y(4) + w(2) + h(2) + pressure(2) + actionButton(4) + buttons(4)
   */
  _injectTouch(action, x, y, pressure) {
    const buf = Buffer.alloc(32);
    let offset = 0;

    buf[offset++] = TYPE_INJECT_TOUCH;           // type
    buf[offset++] = action;                       // action
    buf.writeBigInt64BE(POINTER_MOUSE, offset);   // pointerId (-1 for mouse)
    offset += 8;
    buf.writeInt32BE(x, offset); offset += 4;     // x position
    buf.writeInt32BE(y, offset); offset += 4;     // y position
    buf.writeUInt16BE(this.width, offset); offset += 2;   // screen width
    buf.writeUInt16BE(this.height, offset); offset += 2;  // screen height
    buf.writeUInt16BE(pressure, offset); offset += 2;     // pressure
    buf.writeInt32BE(1, offset); offset += 4;     // actionButton (1 = primary)
    buf.writeInt32BE(action === ACTION_UP ? 0 : 1, offset); // buttons
    this._write(buf);
  }

  /**
   * Inject keycode event.
   * Binary format (14 bytes):
   *   type(1) + action(1) + keycode(4) + repeat(4) + metastate(4)
   */
  _injectKeyDown(keycode) {
    const buf = Buffer.alloc(14);
    buf[0] = TYPE_INJECT_KEYCODE;
    buf[1] = 0; // ACTION_DOWN
    buf.writeInt32BE(keycode, 2);
    buf.writeInt32BE(0, 6);  // repeat
    buf.writeInt32BE(0, 10); // metastate
    this._write(buf);
  }

  _injectKeyUp(keycode) {
    const buf = Buffer.alloc(14);
    buf[0] = TYPE_INJECT_KEYCODE;
    buf[1] = 1; // ACTION_UP
    buf.writeInt32BE(keycode, 2);
    buf.writeInt32BE(0, 6);
    buf.writeInt32BE(0, 10);
    this._write(buf);
  }

  _write(buf) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(buf);
    }
  }
}
