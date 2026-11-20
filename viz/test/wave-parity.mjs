// WP4a — GPU parity for the swept-profile wave + profile strip. Needs a GPU browser, so not a *.test.mjs.
//   node test/wave-parity.mjs            (from viz/)  → exit 0 on pass
// Starts `npx vite --port 5184` (CAPTURE=1), opens dev/wave-parity.html in headless Chrome on the GPU, evaluates
// PROFILE_GLSL in a vertex shader for ≥ 2000 (u, sigma, t) samples per time offset and compares with
// field.sampleFront: max position error < 1e-3 m, max normal error < 1e-3. Then writes test/out/profile-strip.png.
import { spawn, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { renderStrip } from '../dev/wave-strip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIZ = resolve(HERE, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARGS = ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu'];
const POS_TOL = 1e-3, NRM_TOL = 1e-3;

function startVite() {
  return new Promise((res, rej) => {
    const p = spawn('npx vite --port 5184 --strictPort', { cwd: VIZ, env: { ...process.env, CAPTURE: '1' }, shell: true });
    let buf = '';
    const timer = setTimeout(() => rej(new Error('vite did not start:\n' + buf)), 30000);
    const on = (d) => {
      buf += d.toString();
      const m = buf.replace(/\x1b\[[0-9;]*m/g, '').match(/Local:\s+(http:\/\/\S+?)\/?\s/);
      if (m) { clearTimeout(timer); res({ proc: p, url: m[1] }); }
    };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('exit', (c) => rej(new Error('vite exited ' + c + '\n' + buf)));
  });
}
function stopVite(p) {
  try { if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' }); else p.kill(); } catch { /* gone */ }
}

let vite, browser, ok = false;
try {
  vite = await startVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ARGS });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await page.goto(vite.url + '/dev/wave-parity.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 }).catch((e) => { throw new Error(e.message + '\n' + logs.join('\n')); });
  const t0 = Date.now();
  const s = await page.evaluate(() => window.__runParity({ n: 2400, offsets: [0, 3600] }));
  console.log('renderer :', s.renderer);
  console.log(`samples  : ${s.samples}  (${Date.now() - t0} ms)`);
  console.log(`position : max ${s.maxPos.toExponential(3)} m   p99 ${s.p99Pos.toExponential(3)} m   (tol ${POS_TOL})`);
  console.log(`normal   : max ${s.maxNrm.toExponential(3)}     p99 ${s.p99Nrm.toExponential(3)}     (tol ${NRM_TOL})`);
  console.log(`tau      : max ${s.maxTau.toExponential(3)}   thick: max ${s.maxThick.toExponential(3)} m   over tol: ${s.over}`);
  if (s.maxPos >= POS_TOL) console.log('worst position:', JSON.stringify(s.worstPos));
  if (s.maxNrm >= NRM_TOL) console.log('worst normal  :', JSON.stringify(s.worstNrm));
  ok = s.samples >= 2000 && s.maxPos < POS_TOL && s.maxNrm < NRM_TOL;
  if (/swiftshader|llvmpipe|software/i.test(s.renderer)) console.log('WARNING: software renderer, not the GPU');
  const png = await renderStrip(resolve(HERE, 'out/profile-strip.png'), chromium);
  console.log('strip    :', png);
} catch (e) {
  console.error(e);
} finally {
  if (browser) await browser.close();
  if (vite) stopVite(vite.proc);
}
console.log(ok ? 'PARITY PASS' : 'PARITY FAIL');
process.exit(ok ? 0 : 1);
