#!/usr/bin/env node
// Resume / determinism test for tools/capture.mjs (WP8). Browser + GPU based, not part of `npm test`.
//
//   node test/capture-resume.mjs [--frames 40] [--from 15] [--fps 30] [--angle vulkan] [--port 5189]
//                                [--skip-extra]
//
// One frozen app snapshot (captures/wp8-resume/build) is shared by every run:
//   A  uninterrupted capture of N frames
//   B  in-process: the whole browser is crashed after frame 17 → automatic relaunch + resume
//   C  CLI child process killed (process.exit) after frame 17, then the CLI is run again → resume from disk
//   D  (extra) GPU process crash after frame 9 (context loss) → automatic recovery
//   E  (extra) periodic browser restart every 12 frames
//   F  (extra) renderer process crash after frame 20;  G  (extra) WEBGL_lose_context after frame 25
// and every frame of B..E is compared with A (byte-identical PNG, else decoded max channel diff).
// Chunking: three fresh pages step N frames at 24 fps with exact 1/24 s, with 0.041667 s from frame N/2 on,
// and with every frame split into two __advance calls (0.02 + rest); frame pixels (SHA-256 of readPixels)
// and __simTime are compared. Writes captures/wp8-resume/report.json; exit code 1 on any mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture, CAPTURES } from '../tools/capture.mjs';
import { VIZ, argParser, resolveDemo, buildSnapshot, startStaticServer, launchBrowser, appUrl, openApp } from '../tools/lib/browser.mjs';
import { comparePng } from '../tools/lib/pngdiff.mjs';

const { has, opt } = argParser();
const N = +opt('frames', 40), FROM = +opt('from', 15), FPS = +opt('fps', 30), ANGLE = opt('angle', 'vulkan'), PORT = +opt('port', 5189);
const DEMO = 'demo/demo-basic.json', KILL_AT = 17;
const out = path.join(CAPTURES, 'wp8-resume');
fs.mkdirSync(out, { recursive: true });
const report = { when: new Date().toISOString(), frames: N, from: FROM, fps: FPS, angle: ANGLE, runs: {}, compare: {}, chunking: null };
const log = (...a) => console.log(...a);

const t0 = Date.now();
const demo = resolveDemo(DEMO);
const snap = path.join(out, 'build');
await buildSnapshot(snap, { files: [{ file: demo.file, rel: demo.rel }] });
log(`snapshot ${snap} (${Date.now() - t0} ms)`);

const base = { demo: DEMO, from: FROM, frames: N, fps: FPS, w: 1280, h: 720, port: PORT, build: snap, angle: ANGLE, fresh: true };
const quiet = (name) => (m) => { if (!/^\s+frame /.test(m)) log(`[${name}] ${m}`); };
const summary = (m) => ({ sessions: m.sessions.map((s) => ({ start: s.startFrame, frames: s.frames, end: s.end, error: s.error, fps: s.fps })),
  fps: m.timings?.framesPerSec, driftMax: m.drift.maxAbs, renderer: m.renderer });

// ---------------------------------------------------------------- A, B (in-process)
const runs = [['A', {}], ['B', { fault: `browser@${KILL_AT}` }]];
if (!has('skip-extra')) runs.push(['D', { fault: 'gpu@9' }], ['E', { restartEvery: 12 }], ['F', { fault: 'renderer@20' }], ['G', { fault: 'ctxlost@25' }]);
for (const [id, extra] of runs) {
  const m = await capture({ ...base, ...extra, name: `wp8-resume-${id}`, log: quiet(id) });
  report.runs[id] = { ...extra, ...summary(m) };
}

// ---------------------------------------------------------------- C (CLI killed, then resumed)
{
  const cli = (extra) => spawnSync(process.execPath, [path.join(VIZ, 'tools', 'capture.mjs'), '--name', 'wp8-resume-C', '--demo', DEMO,
    '--from', String(FROM), '--frames', String(N), '--fps', String(FPS), '--port', String(PORT), '--build', snap, '--angle', ANGLE, ...extra],
  { cwd: VIZ, encoding: 'utf8' });
  const r1 = cli(['--fresh', '--fault', `exit@${KILL_AT}`]);
  const framesDir = path.join(CAPTURES, 'wp8-resume-C', 'frames');
  const onDisk = fs.readdirSync(framesDir).filter((f) => /^\d{5}\.png$/.test(f)).length;
  const r2 = cli([]);
  const m = JSON.parse(fs.readFileSync(path.join(CAPTURES, 'wp8-resume-C', 'manifest.json'), 'utf8'));
  report.runs.C = { killExit: r1.status, framesOnDiskAfterKill: onDisk, resumeExit: r2.status, ...summary(m) };
  log(`[C] killed with exit ${r1.status} (${onDisk} frames on disk), resumed with exit ${r2.status}`);
  if (r2.status !== 0) log(r2.stdout + r2.stderr);
}

// ---------------------------------------------------------------- compare with A
let ok = true;
for (const id of Object.keys(report.runs).filter((x) => x !== 'A')) {
  const res = { identical: 0, differ: [], maxDiff: 0 };
  for (let k = 0; k < N; k++) {
    const f = String(k).padStart(5, '0') + '.png';
    const c = comparePng(path.join(CAPTURES, 'wp8-resume-A', 'frames', f), path.join(CAPTURES, `wp8-resume-${id}`, 'frames', f), 1280);
    if (c.identical) res.identical++;
    else { res.differ.push({ k, maxDiff: c.maxDiff, pixels: c.diffPixels }); res.maxDiff = Math.max(res.maxDiff, c.maxDiff); }
  }
  if (res.differ.length) ok = false;
  report.compare[`A-${id}`] = res;
  log(`A vs ${id}: ${res.identical}/${N} byte-identical, max diff ${res.maxDiff}${res.differ.length ? ' differing frames ' + res.differ.map((d) => d.k).join(',') : ''}`);
}

// ---------------------------------------------------------------- chunking (24 fps)
{
  const srv = await startStaticServer(snap, { port: PORT });
  const browser = await launchBrowser({ angle: ANGLE });
  const step = 1 / 24;
  const modes = {
    exact: () => [step],
    rounded: (k) => (k >= N / 2 ? [0.041667] : [step]),
    split: () => [0.02, step - 0.02],
  };
  const res = {};
  try {
    for (const [mode, chunks] of Object.entries(modes)) {
      const { page } = await openApp(browser, appUrl(srv.base, { demo: '/' + DEMO, t0: FROM }), { w: 1280, h: 720 });
      const frames = [];
      for (let k = 0; k < N; k++) {
        const parts = k === 0 ? [0] : chunks(k);
        frames.push(await page.evaluate(async (parts) => {
          let t = 0;
          for (const p of parts) t = window.__advance(p);
          const gl = window.__app.renderer.getContext(), c = gl.canvas, px = new Uint8Array(c.width * c.height * 4);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const d = new Uint8Array(await crypto.subtle.digest('SHA-256', px));
          return { t, hash: Array.from(d.slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('') };
        }, parts));
      }
      res[mode] = frames;
      await page.close();
    }
  } finally { await browser.close(); await srv.close(); }
  const cmp = (m) => {
    const bad = res[m].map((f, k) => (f.hash !== res.exact[k].hash || f.t !== res.exact[k].t ? k : -1)).filter((k) => k >= 0);
    const dt = Math.max(...res[m].map((f, k) => Math.abs(f.t - res.exact[k].t)));
    return { sameFrames: N - bad.length, differ: bad, maxSimTimeDiff: dt };
  };
  report.chunking = { rounded: cmp('rounded'), split: cmp('split'),
    note: 'rounded: 0.041667 instead of 1/24 from frame N/2 (error 3.3e-7 s/frame accumulates in the clock; it reaches DT/2 after ~12500 frames ≈ 8.7 min at 24 fps)' };
  for (const m of ['rounded', 'split']) {
    const c = report.chunking[m];
    if (c.differ.length) ok = false;
    log(`chunking ${m}: ${c.sameFrames}/${N} frames identical to exact 1/24 stepping, max |simTime diff| ${c.maxSimTimeDiff}`);
  }
}

report.ok = ok;
report.wallMs = Date.now() - t0;
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
log(`${ok ? 'PASS' : 'FAIL'} (${(report.wallMs / 1000).toFixed(1)} s) — ${path.join(out, 'report.json')}`);
process.exit(ok ? 0 : 1);
