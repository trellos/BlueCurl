// Fast frame readback for captures (WP8). Instead of canvas.toDataURL (≈30 ms PNG encode on the main
// thread + ≈25 ms base64 transfer over CDP per 1280×720 frame), the page reads the default framebuffer
// with gl.readPixels (≈3 ms), hands the buffer to a pool of Web Workers that flip it, PNG-encode it on an
// OffscreenCanvas (software 2D, opaque pixels → lossless) and POST the bytes to the capture's own static
// server (/__upload/frame/<k>). The capture loop keeps rendering while frames are encoded and uploaded,
// bounded by an in-flight limit.
//
// Page API (installed by installFrameSink): window.__wp8sink = { send(k) → pending, wait(n) → Promise, pending, errors }
const WORKER_SRC = `
onmessage = async (ev) => {
  const { k, w, h, buf, url } = ev.data;
  try {
    const src = new Uint8ClampedArray(buf), out = new Uint8ClampedArray(w * h * 4), row = w * 4;
    for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d', { willReadFrequently: true, alpha: false }).putImageData(new ImageData(out, w, h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    for (let attempt = 0; ; attempt++) {          // a reused keep-alive socket can be reset: retry (idempotent)
      try {
        const r = await fetch(url + k, { method: 'POST', body: blob });
        if (!r.ok) throw new Error('upload HTTP ' + r.status + ' ' + (await r.text()));
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
      }
    }
    postMessage({ k, ok: true, bytes: blob.size });
  } catch (e) { postMessage({ k, ok: false, error: String(e && e.message || e) }); }
};`;

/** Install the worker pool in the page. */
// Workers are replaced after `recycle` frames: the PNG blobs they create are only freed with their context,
// and once a page has produced ≈500 MB of blobs Chrome's blob storage refuses more ("Failed to fetch").
export async function installFrameSink(page, { workers = 4, recycle = 32 } = {}) {
  await page.evaluate(({ src, workers, recycle }) => {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const sink = { pending: 0, errors: [], done: 0, waiters: [], next: 0, recycled: 0 };
    const settle = () => {
      sink.waiters = sink.waiters.filter((w) => {
        if (sink.errors.length) { w.reject(new Error(sink.errors.join('; '))); return false; }
        if (sink.pending <= w.n) { w.resolve(sink.pending); return false; }
        return true;
      });
    };
    const mkSlot = () => {
      const s = { w: new Worker(url), pending: 0, jobs: 0, retired: false };
      const done = () => { s.pending--; sink.pending--; if (s.retired && s.pending === 0) s.w.terminate(); settle(); };
      s.w.onmessage = (ev) => { if (ev.data.ok) sink.done++; else sink.errors.push(`frame ${ev.data.k}: ${ev.data.error}`); done(); };
      s.w.onerror = (ev) => { sink.errors.push('worker: ' + (ev.message || 'error')); done(); };
      return s;
    };
    const pool = Array.from({ length: workers }, mkSlot);
    const dispatch = (msg, transfer) => {
      const i = sink.next++ % pool.length;
      let s = pool[i];
      if (s.jobs >= recycle) { s.retired = true; if (s.pending === 0) s.w.terminate(); s = pool[i] = mkSlot(); sink.recycled++; }
      s.jobs++; s.pending++; sink.pending++;
      s.w.postMessage(msg, transfer);
    };
    const app = window.__app, gl = app.renderer.getContext();
    sink.send = (k) => {
      const c = gl.canvas, w = c.width, h = c.height;
      const buf = new Uint8Array(w * h * 4);
      const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      if (prevPack) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
      if (prevPack) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
      if (gl.isContextLost()) return -1;
      dispatch({ k, w, h, buf: buf.buffer, url: location.origin + '/__upload/frame/' }, [buf.buffer]);
      return sink.pending;
    };
    sink.wait = (n = 0) => new Promise((resolve, reject) => { sink.waiters.push({ n, resolve, reject }); settle(); });
    window.__wp8sink = sink;
  }, { src: WORKER_SRC, workers, recycle });
}
