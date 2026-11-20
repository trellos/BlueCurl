// STUB (owner WP3). Contract: see src/contracts.js "input API".
export class InputBus {
  constructor(now = () => 0) { this.now = now; this.log = []; this._cursor = 0; this._seq = 0; this._id = 0; }
  impulse(o = {}) { return -1; }
  release(id, time = null) {}
  setConfig(key, value, time = null) {}
  drainUntil(t) { return []; }
  load(log) { this.log = log.slice(); this._cursor = 0; }
  reset() { this._cursor = 0; }
  bindKeyboard(target = window) {}
}
