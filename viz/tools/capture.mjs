#!/usr/bin/env node
// Deterministic, resumable frame capture + video (WP8).
//
//   node tools/capture.mjs --name NAME [--demo demo/demo-basic.json] --from 0 (--to 75 | --frames N) --fps 30
//        [--w 1280 --h 720] [--port 5188] [--query k=v&k2=v2] [--video] [--crf 20] [--preroll 0]
//        [--restart-every 600] [--angle vulkan] [--headed] [--dev | --build DIR] [--fresh] [--retries 5]
//        [--grab] [--workers 4] [--inflight 8] [--frame-timeout 60]
//        [--fault browser|renderer|gpu|ctxlost|exit@K]   (test only: inject a failure after frame K)
//
// Readback: frames are read with gl.readPixels and PNG-encoded / uploaded by Web Workers in the page
// (tools/lib/framesink.mjs); --grab (and --dev) use window.__grab() (canvas.toDataURL) instead, ~3× slower.
//
// Frame k (0-based, k < N, N = round((to - from) * fps), i.e. `to` is exclusive) is the state at sim time
// T_k = from + k / fps. Output: captures/NAME/frames/%05d.png, captures/NAME/manifest.json and, with
// --video, captures/NAME/NAME.mp4 (libx264, yuv420p).
//
// Source: by default the app is built once (vite build) into captures/NAME/build together with a copy of
// the demo log and served statically, so a long or resumed capture keeps rendering the same code while
// the sources are edited. --dev serves the live sources through the Vite dev server instead; --build DIR
// reuses an existing snapshot (several captures that must match, e.g. the resume test).
//
// Resume: frames already on disk are kept (after checking the manifest params match) and the capture
// continues from the first missing frame k: the page restarts with ?t0=T_(k-p) (sim-only fast-forward,
// p = preroll frames, default 0) and steps one __advance(1/fps) per frame, so the state equals an
// uninterrupted run. Browser / renderer / GPU crashes, WebGL context loss and hung frames relaunch the
// browser and resume automatically; the browser is also restarted every --restart-every frames.
// Each frame asserts |__simTime() - T_k| <= DT/2 (no drift); the max error is in the manifest.
//
// GPU backend: ANGLE Vulkan by default — the only backend measured to give reproducible frames here.
// Plain D3D11 (tools/shot.mjs's default) intermittently corrupts the OceanFFT slope cascade written in the
// compose pass that also builds the mipmaps (~1 frame in 4 shows a different water micro-normal pattern);
// D3D11on12 renders the Fx glow sprites with sporadic 1-LSB differences. test/capture-resume.mjs checks it.
// After a failed session the last --rollback (8) frames are deleted and re-rendered (a dying GPU can
// return garbage pixels one frame before the context loss is reported).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DT } from '../src/contracts.js';
import {
  VIZ, FFMPEG, argParser, sha256, hashDir, writeAtomic, gitInfo, resolveDemo, startDevServer, buildSnapshot,
  copyIntoSnapshot, startStaticServer, launchBrowser, appUrl, rendererString, withTimeout, openApp,
} from './lib/browser.mjs';
import { installFrameSink } from './lib/framesink.mjs';

export const CAPTURES = path.join(VIZ, 'captures');
const pad = (k) => String(k).padStart(5, '0');
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

/** First k with no valid frames/%05d.png (the last present frame is checked for a complete PNG). */
export function firstMissingFrame(framesDir, total) {
  let k = 0;
  while (k < total && fs.existsSync(path.join(framesDir, pad(k) + '.png'))) k++;
  if (k > 0) {
    const f = path.join(framesDir, pad(k - 1) + '.png');
    const b = fs.readFileSync(f);
    if (b.length < 64 || b.subarray(b.length - 8, b.length - 4).toString('latin1') !== 'IEND') { fs.unlinkSync(f); k--; }
  }
  return k;
}

const PNG_OK = (s) => typeof s === 'string' && s.startsWith('data:image/png;base64,') && s.length > 1000;

/**
 * Run (or resume) a capture. opts: { name, demo, from, to | frames, fps, w, h, port, query, video, crf,
 * preroll, restartEvery, angle, headed, dev, build, fresh, retries, frameTimeout, fault, log }.
 * Returns the manifest.
 */
export async function capture(opts) {
  const o = {
    from: 0, fps: 30, w: 1280, h: 720, port: 5188, query: '', video: false, crf: 20, preroll: 0,
    restartEvery: 600, angle: 'vulkan', headed: false, dev: false, build: null, fresh: false, retries: 5,
    frameTimeout: 60000, fault: null, rollback: 8, grab: false, workers: 4, inflight: 8, log: console.log, ...opts,
  };
  const log = o.log;
  if (!o.name || /[\\/]/.test(o.name)) throw fatal('capture: --name NAME required (no slashes)');
  const fps = +o.fps, from = +o.from;
  const total = o.frames != null ? Math.round(+o.frames) : Math.round((+o.to - from) * fps);
  if (!(fps > 0) || !(total > 0) || !(from >= 0)) throw fatal(`capture: bad range (from ${o.from}, to ${o.to}, frames ${o.frames}, fps ${o.fps})`);
  const T = (k) => from + k / fps;

  const dir = path.join(CAPTURES, o.name);
  const framesDir = path.join(dir, 'frames');
  const manifestFile = path.join(dir, 'manifest.json');
  const videoFile = path.join(dir, o.name + '.mp4');
  if (o.fresh) {
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.rmSync(manifestFile, { force: true });
    fs.rmSync(videoFile, { force: true });
    if (!o.build) fs.rmSync(path.join(dir, 'build'), { recursive: true, force: true });
  }
  fs.mkdirSync(framesDir, { recursive: true });
  for (const f of fs.readdirSync(framesDir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(framesDir, f), { force: true });

  // ---------------------------------------------------------------- params + resume check
  const demo = resolveDemo(o.demo);
  const params = {
    demo: demo ? (demo.url || demo.rel) : null, demoSha: demo?.file ? sha256(fs.readFileSync(demo.file)) : null,
    from, fps, w: +o.w, h: +o.h, query: String(o.query || '').replace(/^[?&]+/, ''), preroll: +o.preroll,
    angle: o.angle, source: o.dev ? 'dev' : 'build',
  };
  let manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const onDisk = fs.readdirSync(framesDir).filter((f) => /^\d{5}\.png$/.test(f)).length;
  if (onDisk > 0 && !manifest) throw fatal(`${framesDir} has ${onDisk} frames but no manifest.json; use --fresh`);
  if (manifest) {
    const was = { ...manifest.params };
    const diffs = Object.keys({ ...was, ...params }).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(params[k]));
    // a changed demo file is fine when the frozen snapshot keeps the original copy
    const demoOnly = diffs.length === 1 && diffs[0] === 'demoSha' && params.source === 'build';
    if (diffs.length && !demoOnly && onDisk > 0) {
      throw fatal(`params differ from ${manifestFile}: ${diffs.map((k) => `${k} ${JSON.stringify(was[k])} -> ${JSON.stringify(params[k])}`).join(', ')}; use --fresh or another --name`);
    }
    if (demoOnly) { log(`note: ${params.demo} changed since the capture began; using the frozen copy in the snapshot`); params.demoSha = was.demoSha; }
    if (manifest.frames?.total !== total) log(`note: frame count ${manifest.frames?.total} -> ${total}`);
  }
  if (!manifest || onDisk === 0) {
    manifest = { tool: 'viz/tools/capture.mjs', version: 1, name: o.name, created: new Date().toISOString(),
      params, git: gitInfo(), source: null, renderer: null, frames: { total, done: 0 },
      drift: { maxAbs: 0, atFrame: null, tolerance: DT / 2, dt: DT }, sessions: [], warnings: [] };
  }
  manifest.params = params;
  manifest.frames.total = total;
  manifest.to = T(total);
  const saveManifest = () => { manifest.updated = new Date().toISOString(); writeAtomic(manifestFile, JSON.stringify(manifest, null, 2)); };
  const warn = (m) => { log('WARNING: ' + m); if (!manifest.warnings.includes(m)) manifest.warnings.push(m); };

  let k0 = firstMissingFrame(framesDir, total);
  const needFrames = k0 < total;
  log(`${o.name}: ${total} frames @ ${fps} fps, T ${from}..${T(total - 1).toFixed(4)} s, ${o.w}x${o.h}; ${k0} on disk`);

  // ---------------------------------------------------------------- source (snapshot or dev server)
  let server = null, browser = null;
  const io = { n: 0, ms: 0, max: 0, bytes: 0 };             // frame file writes (upload path)
  const cleanup = async () => { try { await withTimeout(browser?.close(), 15000, "browser.close"); } catch {} browser = null; try { await server?.close(); } catch {} server = null; };
  const onSig = async () => { await cleanup(); process.exit(130); };
  process.once('SIGINT', onSig);
  try {
    let demoUrl = null;
    if (needFrames) {
      if (o.dev) {
        server = await startDevServer({ port: +o.port });
        demoUrl = demo ? (demo.url || '/' + demo.rel) : null;
        if (demo?.rel?.startsWith('_demo/')) throw fatal('--dev needs the demo inside viz/');
        manifest.source = { mode: 'dev', base: server.base };
        if (onDisk > 0) warn('resuming against the live dev server: frames match only if the sources did not change');
      } else {
        const snap = o.build ? path.resolve(o.build) : path.join(dir, 'build');
        const files = demo?.file ? [{ file: demo.file, rel: demo.rel }] : [];
        let hash = null;
        if (fs.existsSync(path.join(snap, 'index.html'))) {
          for (const f of files) {                   // reused snapshot: make sure the demo copy is there and the same
            const dst = path.join(snap, f.rel);
            if (!fs.existsSync(dst)) copyIntoSnapshot(snap, f.file, f.rel);
            else if (sha256(fs.readFileSync(dst)) !== params.demoSha) {
              if (o.build) throw fatal(`snapshot ${dst} differs from ${f.file}`);
            }
          }
          hash = hashDir(snap);
          if (manifest.source?.hash && manifest.source.hash !== hash && onDisk > 0) warn(`snapshot ${snap} changed since the capture began (hash ${manifest.source.hash.slice(0, 12)} -> ${hash.slice(0, 12)})`);
          log(`snapshot: reusing ${snap}`);
        } else {
          if (onDisk > 0) warn(`snapshot ${snap} missing; rebuilt from the current sources (resumed frames may differ)`);
          const t = Date.now();
          ({ hash } = await buildSnapshot(snap, { files }));
          log(`snapshot: built ${snap} in ${Date.now() - t} ms`);
        }
        manifest.source = { mode: 'build', dir: path.relative(VIZ, snap).replace(/\\/g, '/'), hash };
        server = await startStaticServer(snap, { port: +o.port, onUpload: async (p, body) => {
          const m = /^frame\/(\d+)$/.exec(p);
          if (!m || +m[1] >= total) throw new Error('bad upload ' + p);
          if (body.length < 1000 || body.readUInt32BE(0) !== 0x89504e47) throw new Error(`frame ${m[1]}: not a PNG (${body.length} bytes)`);
          const t = performance.now();
          const file = path.join(framesDir, pad(+m[1]) + '.png');
          await fs.promises.writeFile(file + '.tmp', body);
          await fs.promises.rename(file + '.tmp', file);
          const ms = performance.now() - t;
          io.n++; io.ms += ms; io.max = Math.max(io.max, ms); io.bytes += body.length;
        } });
        demoUrl = demo ? (demo.url || '/' + demo.rel) : null;
      }
      saveManifest();
    }

    // ---------------------------------------------------------------- sessions
    const prerollFrames = Math.max(0, Math.round(+o.preroll * fps));
    const kMin = -Math.floor(from * fps + 1e-9);         // earliest frame index with T >= 0
    const fault = o.fault ? (() => { const [kind, at] = String(o.fault).split('@'); return { kind, at: +at, fired: false }; })() : null;
    let failures = 0;

    const runSession = async (kFirst) => {
      const kStart = Math.max(kFirst - prerollFrames, kMin);
      const t0 = T(kStart);
      const s = { startFrame: kFirst, t0, preroll: kFirst - kStart, started: new Date().toISOString(), frames: 0 };
      manifest.sessions.push(s);
      const tLaunch = Date.now();
      browser = await launchBrowser({ angle: o.angle, headed: o.headed });
      const url = appUrl(server.base, { w: params.w, h: params.h, demo: demoUrl, t0, query: params.query });
      const { page, logs, bootMs } = await openApp(browser, url, { w: params.w, h: params.h });
      s.bootMs = Date.now() - tLaunch;
      const renderer = await rendererString(page);
      if (!manifest.renderer) manifest.renderer = renderer;
      else if (manifest.renderer !== renderer) warn(`renderer changed: ${manifest.renderer} -> ${renderer}`);
      if (!/nvidia/i.test(renderer)) warn(`not running on the NVIDIA GPU (${renderer})`);
      log(`session @frame ${kFirst} (t0 ${t0.toFixed(4)} s): boot ${s.bootMs} ms (page ${bootMs} ms) — ${renderer}`);
      const nLogs = logs.length;
      const fast = !o.dev && !o.grab;
      s.readback = fast ? `readPixels+workers(${o.workers})` : 'toDataURL';
      if (fast) await installFrameSink(page, { workers: o.workers });

      const tLoop = Date.now();
      let k = kStart, dt = 0, rendered = 0, lastSave = Date.now(), lastGrab = -1;
      try {
        while (k < total && s.frames < o.restartEvery) {
          if (page.__crashed) throw new Error('renderer crashed');
          const grab = k >= kFirst;
          const r = await withTimeout(page.evaluate(({ dt, grab, fast, k }) => {
            const t = window.__advance(dt);
            const gl = window.__app && window.__app.renderer.getContext();
            if (gl && gl.isContextLost()) return { lost: true, t };
            if (!grab) return { t };
            if (!fast) return { t, png: window.__grab() };
            const s = window.__wp8sink;
            if (s.errors.length) return { t, error: s.errors.join('; ') };
            return { t, pending: s.send(k) };
          }, { dt, grab, fast, k }), o.frameTimeout, `frame ${k}`);
          if (r.lost || r.pending < 0) throw new Error(`WebGL context lost at frame ${k}`);
          if (r.error) throw new Error(`frame upload failed: ${r.error}`);
          const err = r.t - T(k);
          if (Math.abs(err) > manifest.drift.maxAbs) { manifest.drift.maxAbs = Math.abs(err); manifest.drift.atFrame = k; }
          if (!(Math.abs(err) <= DT / 2 + 1e-9)) throw fatal(`drift at frame ${k}: __simTime ${r.t} vs T_k ${T(k)} (> DT/2)`);
          if (grab) {
            if (fast) {
              if (r.pending >= o.inflight) await withTimeout(page.evaluate((n) => window.__wp8sink.wait(n), o.inflight >> 1), o.frameTimeout, 'frame uploads');
            } else {
              if (!PNG_OK(r.png)) throw new Error(`frame ${k}: empty grab (${String(r.png).slice(0, 40)})`);
              writeAtomic(path.join(framesDir, pad(k) + '.png'), Buffer.from(r.png.slice(22), 'base64'));
            }
            s.frames++;
            lastGrab = k;
            failures = 0;
            if (fault && !fault.fired && k >= fault.at) { fault.fired = true; await injectFault(fault.kind, browser, page, log); }
            if (Date.now() - lastSave > 5000) { s.ms = Date.now() - tLoop; s.fps = +(s.frames / (s.ms / 1000)).toFixed(2); saveManifest(); lastSave = Date.now(); }
            if (k % 60 === 0 || k === total - 1) log(`  frame ${pad(k)}/${total} T ${T(k).toFixed(4)} sim ${r.t.toFixed(4)}  ${(s.frames / ((Date.now() - tLoop) / 1000)).toFixed(1)} fps`);
          }
          rendered++;
          k++;
          dt = 1 / fps;
        }
        if (fast) await withTimeout(page.evaluate(() => window.__wp8sink.wait(0)), o.frameTimeout, 'final frame uploads');
        if (await page.evaluate(() => window.__app.renderer.getContext().isContextLost())) throw new Error('WebGL context lost after the last frame');
        s.end = k >= total ? 'done' : 'restart';
      } catch (e) {
        s.end = 'error';
        s.error = String(e.message || e).split('\n')[0].slice(0, 300);
        // frames read back just before a GPU / renderer failure may be garbage: re-render the last few
        if (lastGrab >= 0) e.rollback = { from: Math.max(kFirst, lastGrab - o.rollback + 1), to: lastGrab + o.inflight, session: s };
        throw e;
      } finally {
        s.ms = Date.now() - tLoop;
        s.fps = s.frames ? +(s.frames / (s.ms / 1000)).toFixed(2) : 0;
        s.rendered = rendered;
        if (io.n) { s.write = { files: io.n, msMean: +(io.ms / io.n).toFixed(1), msMax: +io.max.toFixed(1), MB: +(io.bytes / 1e6).toFixed(1) }; Object.assign(io, { n: 0, ms: 0, max: 0, bytes: 0 }); }
        manifest.frames.done = firstMissingFrame(framesDir, total);
        const errs = logs.slice(nLogs).filter((l) => /pageerror|\[error\]|\[crash\]/.test(l));
        if (errs.length) s.pageErrors = errs.slice(0, 10).map((l) => l.slice(0, 300));
        saveManifest();
        try { await withTimeout(browser?.close(), 15000, "browser.close"); } catch {}
        browser = null;
      }
    };

    const tAll = Date.now();
    while ((k0 = firstMissingFrame(framesDir, total)) < total) {
      try {
        await runSession(k0);
      } catch (e) {
        if (e.fatal) throw e;
        failures++;
        log(`session failed (${failures}/${o.retries}): ${String(e.message || e).split('\n')[0]}`);
        try { await withTimeout(browser?.close(), 15000, "browser.close"); } catch {}
        browser = null;
        if (e.rollback) {
          await new Promise((r) => setTimeout(r, 200));       // let uploads already received finish writing
          let n = 0;
          for (let k = e.rollback.from; k <= Math.min(e.rollback.to, total - 1); k++) {
            const f = path.join(framesDir, pad(k) + '.png');
            if (fs.existsSync(f)) { fs.unlinkSync(f); n++; }
          }
          e.rollback.session.rolledBack = [e.rollback.from, e.rollback.to, n];
          log(`  rolled back ${n} frames from ${e.rollback.from}`);
          saveManifest();
        }
        if (failures >= o.retries) throw fatal(`giving up after ${failures} failed sessions without progress`);
      }
    }
    if (needFrames) {
      const done = manifest.sessions.filter((s) => s.frames > 0);
      const frames = done.reduce((a, s) => a + s.frames, 0), ms = done.reduce((a, s) => a + s.ms, 0);
      const boot = manifest.sessions.reduce((a, s) => a + (s.bootMs || 0), 0);
      manifest.timings = { framesCaptured: frames, frameLoopMs: ms, bootMs: boot, framesPerSec: +(frames / (ms / 1000)).toFixed(2),
        framesPerSecInclBoot: +(frames / ((ms + boot) / 1000)).toFixed(2), lastRunWallMs: Date.now() - tAll };
      log(`${o.name}: frames done; ${manifest.timings.framesPerSec} fps in the frame loop, ${manifest.timings.framesPerSecInclBoot} fps incl. boot; max |sim - T_k| ${manifest.drift.maxAbs.toExponential(2)} s`);
    }
    manifest.frames.done = total;
    manifest.complete = true;
    saveManifest();
  } finally {
    process.removeListener('SIGINT', onSig);
    await cleanup();
  }

  // ---------------------------------------------------------------- video
  if (o.video) {
    const v = manifest.video;
    if (v && v.frames === total && v.crf === +o.crf && v.fps === fps && fs.existsSync(videoFile)) log(`video: up to date ${videoFile}`);
    else {
      const t = Date.now();
      const pad2 = params.w % 2 || params.h % 2 ? ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'] : [];
      execFileSync(FFMPEG, ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(framesDir, '%05d.png'),
        '-frames:v', String(total), ...pad2, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(o.crf),
        '-movflags', '+faststart', videoFile], { stdio: ['ignore', 'inherit', 'inherit'] });
      manifest.video = { file: path.basename(videoFile), frames: total, fps, crf: +o.crf, ms: Date.now() - t, bytes: fs.statSync(videoFile).size };
      saveManifest();
      log(`video: ${videoFile} (${(manifest.video.bytes / 1e6).toFixed(1)} MB, ${manifest.video.ms} ms)`);
    }
  }
  return manifest;
}

/** Test-only failure injection (--fault kind@K). */
async function injectFault(kind, browser, page, log) {
  log(`  [fault] injecting '${kind}'`);
  if (kind === 'exit') process.exit(137);                       // hard kill of this process (no cleanup)
  if (kind === 'browser' || kind === 'gpu') {
    const cdp = await browser.newBrowserCDPSession();
    cdp.send(kind === 'browser' ? 'Browser.crash' : 'Browser.crashGpuProcess').catch(() => {});
  } else if (kind === 'renderer') {
    const cdp = await page.context().newCDPSession(page);
    cdp.send('Page.crash').catch(() => {});
  } else if (kind === 'ctxlost') {
    await page.evaluate(() => window.__app.renderer.getContext().getExtension('WEBGL_lose_context')?.loseContext());
  } else throw fatal(`unknown fault '${kind}'`);
  await new Promise((r) => setTimeout(r, 300));
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { has, opt } = argParser();
  if (!opt('name') || has('help')) {
    console.error('usage: node tools/capture.mjs --name NAME [--demo demo/x.json] --from 0 (--to 75 | --frames N) --fps 30 [--w 1280 --h 720]\n' +
      '         [--port 5188] [--query k=v] [--video] [--crf 20] [--preroll 0] [--restart-every 600] [--angle vulkan] [--headed]\n' +
      '         [--dev | --build DIR] [--fresh] [--retries 5] [--rollback 8] [--grab] [--workers 4] [--inflight 8] [--fault kind@K]');
    process.exit(2);
  }
  const num = (k, d) => (opt(k) != null ? +opt(k) : d);
  try {
    await capture({
      name: opt('name'), demo: opt('demo'), from: num('from', 0), to: num('to', undefined), frames: opt('frames') != null ? +opt('frames') : undefined,
      fps: num('fps', 30), w: num('w', 1280), h: num('h', 720), port: num('port', 5188), query: opt('query', ''),
      video: has('video'), crf: num('crf', 20), preroll: num('preroll', 0), restartEvery: num('restart-every', 600),
      angle: opt('angle', 'vulkan'), headed: has('headed'), dev: has('dev'), build: opt('build', null), fresh: has('fresh'),
      retries: num('retries', 5), frameTimeout: num('frame-timeout', 60) * 1000, fault: opt('fault', null),
      rollback: num('rollback', 8), grab: has('grab'), workers: num('workers', 4), inflight: num('inflight', 8),
    });
    process.exit(0);
  } catch (e) {
    console.error('capture failed:', e.stack || e.message || e);
    process.exit(1);
  }
}
