export class WsClient {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.binaryHandler = null;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._shouldReconnect = true;
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this._reconnectDelay = 1000;
      this._emit('connected');
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      this._emit('disconnected');
      if (this._shouldReconnect) {
        setTimeout(() => this.connect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };

    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (this.binaryHandler) {
          this.binaryHandler(event.data);
        }
      } else {
        try {
          const msg = JSON.parse(event.data);
          this._emit(msg.type, msg);
        } catch (e) {
          console.error('[WS] Bad message:', e);
        }
      }
    };
  }

  disconnect() {
    this._shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
    }
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onBinary(handler) {
    this.binaryHandler = handler;
  }

  on(event, handler) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(handler);
  }

  _emit(event, data) {
    const handlers = this.handlers[event];
    if (handlers) {
      handlers.forEach(h => h(data));
    }
  }
}
