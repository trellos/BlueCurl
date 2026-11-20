// Segmented video output for captures (WP8): frames (raw RGBA, top row first) are streamed in frame order into
// one ffmpeg/x264 process per segment of `seg` frames → <dir>/<i:04d>.mp4 (written as .tmp, renamed when the
// encoder exits cleanly). Each segment is a self-contained file starting on an IDR frame, so the segments
// concatenate losslessly with the concat demuxer (-c copy). Frames may be pushed out of order; they are
// buffered and fed in order. No PNG frames touch the disk.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { FFMPEG } from './browser.mjs';

export const segFile = (dir, i) => path.join(dir, String(i).padStart(4, '0') + '.mp4');

export class SegmentWriter {
  /** opts: { dir, fps, w, h, seg, total, crf, start (first frame, a segment start), onSegment({i, from, frames, bytes, ms}) } */
  constructor(opts) {
    Object.assign(this, opts);
    this.next = opts.start;
    this.buf = new Map();
    this.proc = null;
    this.closing = new Set();
    this.error = null;
    this.chain = Promise.resolve();
    this.waiters = [];
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get backlog() { return this.buf.size; }

  push(k, data) {
    if (k < this.next || this.buf.has(k)) return;              // duplicate (upload retry)
    if (data.length !== this.w * this.h * 4) throw new Error(`frame ${k}: ${data.length} bytes, expected ${this.w * this.h * 4}`);
    this.buf.set(k, data);
    this.chain = this.chain.then(() => this._pump()).catch((e) => { this.error ??= e; this._wake(); });
  }

  async _pump() {
    while (!this.error && this.buf.has(this.next)) {
      const k = this.next, data = this.buf.get(k);
      if (!this.proc) this._open(Math.floor(k / this.seg));
      const p = this.proc;
      if (!p.stdin.write(data)) await Promise.race([new Promise((r) => p.stdin.once('drain', r)), p.dead]);
      this.buf.delete(k);
      p.frames++;
      this.next++;
      if (p.frames === p.count) this._close(p);
      this._wake();
    }
  }

  _open(i) {
    const from = i * this.seg, count = Math.min(this.seg, this.total - from);
    const file = segFile(this.dir, i), tmp = `${file}.${process.pid}.tmp`;
    const pad = this.w % 2 || this.h % 2 ? ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'] : [];
    const p = spawn(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${this.w}x${this.h}`,
      '-framerate', String(this.fps), '-i', '-', ...pad, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(this.crf),
      '-pix_fmt', 'yuv420p', '-g', String(this.seg), '-video_track_timescale', String(this.fps * 1000),
      '-movflags', '+faststart', '-f', 'mp4', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
    Object.assign(p, { i, from, count, file, tmp, frames: 0, t0: Date.now(), err: '' });
    p.stderr.on('data', (d) => { p.err += d; });
    p.stdin.on('error', () => {});
    p.done = new Promise((resolve) => p.once('exit', (code) => resolve(code)));
    p.dead = p.done.then((code) => { throw new Error(`ffmpeg segment ${i} exited (${code}) while encoding: ${p.err.slice(0, 300)}`); });
    p.dead.catch(() => {});
    this.proc = p;
  }

  _close(p) {
    this.proc = null;
    p.stdin.end();
    const job = p.done.then((code) => {
      this.closing.delete(job);
      if (code !== 0 || !fs.existsSync(p.tmp)) throw new Error(`ffmpeg segment ${p.i} exit ${code}: ${p.err.slice(0, 300)}`);
      fs.renameSync(p.tmp, p.file);
      this.onSegment?.({ i: p.i, from: p.from, frames: p.count, bytes: fs.statSync(p.file).size, ms: Date.now() - p.t0 });
    }).catch((e) => { this.error ??= e; }).finally(() => this._wake());
    this.closing.add(job);
  }

  _wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }

  /** Resolve once fewer than n frames are buffered (backpressure for the capture loop). */
  async waitBelow(n) {
    while (!this.error && this.buf.size >= n) await new Promise((r) => this.waiters.push(r));
    if (this.error) throw this.error;
  }

  /** Wait until every pushed frame is encoded and every finished segment is closed. */
  async flush() {
    await this.chain;
    await Promise.all([...this.closing]);
    if (this.error) throw this.error;
  }

  /** Kill a running encoder and remove its partial file. */
  async abort() {
    const p = this.proc;
    this.proc = null;
    this.error ??= new Error('aborted');
    if (p) { try { p.kill('SIGKILL'); } catch {} await p.done; fs.rmSync(p.tmp, { force: true }); }
    await Promise.allSettled([...this.closing]);
  }
}

/** Concatenate segment files (in order) into out with the concat demuxer, stream copy. */
export function concatSegments(files, out) {
  const list = out + '.txt';
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  try {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out],
      { stdio: ['ignore', 'inherit', 'inherit'] });
  } finally { fs.rmSync(list, { force: true }); }
}
