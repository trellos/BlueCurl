// STUB (owner WP7). Wide default view + automatic PiP follow cam.
export class CameraRig {
  constructor(app) { this.app = app; this.pip = { active: false, riderId: null, rect: null }; }
  step(t, dt) {}
  render(app) { app.post.render(app.scene, app.camera); }
}
