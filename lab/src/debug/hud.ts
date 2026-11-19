// Performance HUD: frame time, per-stage CPU ms, draw calls, triangles, memory.

import type * as THREE from 'three';

export class Profiler {
  readonly stages = new Map<string, { ema: number; last: number; max: number }>();
  private t0 = new Map<string, number>();

  begin(name: string): void {
    this.t0.set(name, performance.now());
  }

  end(name: string): number {
    const dt = performance.now() - (this.t0.get(name) ?? performance.now());
    this.add(name, dt);
    return dt;
  }

  add(name: string, ms: number): void {
    let s = this.stages.get(name);
    if (!s) {
      s = { ema: ms, last: ms, max: ms };
      this.stages.set(name, s);
    }
    s.last = ms;
    s.ema += (ms - s.ema) * 0.05;
    s.max = Math.max(s.max * 0.995, ms);
  }
}

export class Hud {
  readonly el: HTMLDivElement;
  private frameEma = 16.7;
  private lastFrame = performance.now();
  private nextDraw = 0;
  extra: () => string = () => '';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    parent.appendChild(this.el);
  }

  frame(): void {
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    this.frameEma += (dt - this.frameEma) * 0.05;
  }

  draw(prof: Profiler, renderer: THREE.WebGLRenderer, simTime: number, info: string): void {
    const now = performance.now();
    if (now < this.nextDraw) return;
    this.nextDraw = now + 250;
    const r = renderer.info;
    const lines = [
      `t ${simTime.toFixed(2)} s   ${info}`,
      `frame ${this.frameEma.toFixed(1)} ms (${(1000 / this.frameEma).toFixed(0)} fps)`,
      `draws ${r.render.calls}  tris ${(r.render.triangles / 1000).toFixed(1)}k  geo ${r.memory.geometries}  tex ${r.memory.textures}`,
    ];
    for (const [name, s] of prof.stages) {
      lines.push(`${name.padEnd(12)} ${s.ema.toFixed(3)} ms  (max ${s.max.toFixed(2)})`);
    }
    const x = this.extra();
    if (x) lines.push(x);
    this.el.textContent = lines.join('\n');
  }
}
