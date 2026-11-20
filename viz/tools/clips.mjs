#!/usr/bin/env node
// Render a list of named clips (WP8), sequentially, each through tools/capture.mjs and therefore resumable:
// re-running the same command continues every unfinished clip from the frames on disk.
//
//   node tools/clips.mjs [tools/clips.json] [--only name1,name2] [--list] [--fresh] [--port 5188] [--angle vulkan]
//
// Spec: { "defaults": { ...capture options }, "clips": [ { "name", "demo", "from", "to" | "frames", "fps",
//         "size": "1280x720" | "w"/"h", "query": "k=v&k2=v2" | {k: v}, "video", "crf", "preroll" }, ... ] }
// Clip fields override the defaults; output goes to captures/<name>/ (frames, manifest.json, <name>.mp4).
import fs from 'node:fs';
import path from 'node:path';
import { capture } from './capture.mjs';
import { VIZ, argParser } from './lib/browser.mjs';

const { has, opt, positional } = argParser();
const specFile = path.resolve(VIZ, positional[0] || 'tools/clips.json');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const only = opt('only') ? new Set(opt('only').split(',')) : null;

const toOpts = (c) => {
  const o = { ...(spec.defaults || {}), ...c };
  if (o.size) { const [w, h] = String(o.size).split('x').map(Number); o.w = w; o.h = h; delete o.size; }
  if (o.query && typeof o.query === 'object') o.query = new URLSearchParams(Object.entries(o.query).map(([k, v]) => [k, String(v)])).toString();
  if (opt('port')) o.port = +opt('port');
  if (opt('angle')) o.angle = opt('angle');
  if (has('fresh')) o.fresh = true;
  return o;
};

const clips = (spec.clips || []).filter((c) => !only || only.has(c.name));
if (has('list')) {
  for (const c of clips) { const o = toOpts(c); console.log(`${o.name}: ${o.demo || '-'} ${o.from}..${o.to ?? `+${o.frames}f`} s @ ${o.fps} fps ${o.w}x${o.h}${o.query ? ' ?' + o.query : ''}${o.video ? ' +video' : ''}`); }
  process.exit(0);
}

const results = [];
const t0 = Date.now();
for (const c of clips) {
  const o = toOpts(c);
  console.log(`\n=== ${o.name}`);
  const t = Date.now();
  try {
    const m = await capture(o);
    results.push({ name: o.name, ok: true, frames: m.frames.total, fps: m.timings?.framesPerSec, s: (Date.now() - t) / 1000, video: m.video?.file });
  } catch (e) {
    console.error(`${o.name} FAILED: ${String(e.message || e).split('\n')[0]}`);
    results.push({ name: o.name, ok: false, error: String(e.message || e).split('\n')[0] });
  }
}
console.log(`\nclips (${((Date.now() - t0) / 1000).toFixed(0)} s):`);
for (const r of results) console.log(r.ok ? `  ok    ${r.name}: ${r.frames} frames, ${r.fps ?? '-'} fps, ${r.s.toFixed(0)} s${r.video ? ', ' + r.video : ''}` : `  FAIL  ${r.name}: ${r.error}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
