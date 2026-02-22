/**
 * SSE client for receiving LFS face signals from the personas server.
 * Auto-reconnects with exponential backoff.
 */
export class LfsClient {
  constructor(url) {
    this.url = url;
    this._handlers = {};
    this._es = null;
    this._reconnectDelay = 1000;
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  _emit(event, data) {
    const hs = this._handlers[event];
    if (hs) for (const h of hs) h(data);
  }

  connect() {
    this._emit("status", "Connecting...");
    this._es = new EventSource(this.url);

    this._es.onopen = () => {
      this._reconnectDelay = 1000;
      this._emit("status", "Connected — waiting for signals");
    };

    this._es.onmessage = (event) => {
      try {
        const signal = JSON.parse(event.data);
        this._emit("signal", signal);
      } catch { /* ignore malformed */ }
    };

    this._es.onerror = () => {
      this._emit("status", `Reconnecting in ${this._reconnectDelay / 1000}s...`);
      this._es.close();
      setTimeout(() => this.connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 16000);
    };
  }

  disconnect() {
    if (this._es) {
      this._es.close();
      this._es = null;
    }
  }
}
