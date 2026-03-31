const SWIPE_THRESHOLD = 8; // pixels
const MOVE_THROTTLE_MS = 16; // ~60fps throttle for move events

export class TouchHandler {
  constructor(canvas, sendFn) {
    this.canvas = canvas;
    this.send = sendFn;
    this._tracking = false;
    this._startX = 0;
    this._startY = 0;
    this._lastX = 0;
    this._lastY = 0;
    this._lastMoveTime = 0;
    // 'simple' = tap/swipe only (screencap), 'continuous' = down/move/up (scrcpy)
    this.mode = 'simple';

    // Mouse events
    canvas.addEventListener('mousedown', (e) => this._onDown(e));
    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mouseup', (e) => this._onUp(e));
    canvas.addEventListener('mouseleave', (e) => {
      if (this._tracking) this._onUp(e);
    });

    // Touch events (for mobile browsers testing the mirror)
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._onDown(e.touches[0]);
    });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      this._onMove(e.touches[0]);
    });
    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this._onUp(e.changedTouches[0]);
    });

    // Scroll/wheel events for scrcpy scroll injection
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = this._getNormalized(e);
      this.send({
        type: 'scroll',
        x, y,
        hScroll: -Math.sign(e.deltaX),
        vScroll: -Math.sign(e.deltaY),
      });
    }, { passive: false });

    // Prevent context menu on canvas
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _getNormalized(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;
    return {
      x: Math.max(0, Math.min(1, canvasX / this.canvas.width)),
      y: Math.max(0, Math.min(1, canvasY / this.canvas.height)),
    };
  }

  _onDown(event) {
    this._tracking = true;
    const { x, y } = this._getNormalized(event);
    this._startX = x;
    this._startY = y;
    this._lastX = x;
    this._lastY = y;

    if (this.mode === 'continuous') {
      this.send({ type: 'touch', action: 'down', x, y });
    }
  }

  _onMove(event) {
    if (!this._tracking) return;
    const { x, y } = this._getNormalized(event);
    this._lastX = x;
    this._lastY = y;

    if (this.mode === 'continuous') {
      // Throttle move events
      const now = performance.now();
      if (now - this._lastMoveTime < MOVE_THROTTLE_MS) return;
      this._lastMoveTime = now;
      this.send({ type: 'touch', action: 'move', x, y });
    }
  }

  _onUp(event) {
    if (!this._tracking) return;
    this._tracking = false;

    const { x, y } = this._getNormalized(event);

    if (this.mode === 'continuous') {
      this.send({ type: 'touch', action: 'up', x, y });
    } else {
      // Simple mode: determine tap vs swipe
      const rect = this.canvas.getBoundingClientRect();
      const dx = (x - this._startX) * rect.width;
      const dy = (y - this._startY) * rect.height;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < SWIPE_THRESHOLD) {
        this.send({
          type: 'touch',
          action: 'tap',
          x: this._startX,
          y: this._startY,
        });
      } else {
        this.send({
          type: 'touch',
          action: 'swipe',
          x1: this._startX,
          y1: this._startY,
          x2: x,
          y2: y,
          duration: 300,
        });
      }
    }
  }
}
