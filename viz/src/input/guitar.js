// STUB (orchestrator) — WP10 replaces this with the Tuninator-backed guitar input. Contract: contracts.js "guitar input".
export class GuitarInput {
  constructor(app, opts = {}) {
    this.app = app;
    app.guitar = this;
    this.status = { state: 'off', message: '', key: app.cfg.guitar?.key ?? 'C major', lowRoot: 48, last: null };
  }
  /** Start listening (needs a user gesture). */
  async start() {}
  async stop() {}
  dispose() {}
}
