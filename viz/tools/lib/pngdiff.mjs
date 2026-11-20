// PNG comparison for capture tests (WP8): byte equality first, else decode both with ffmpeg to raw RGB
// and report the max per-channel difference and the number of differing pixels.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FFMPEG } from './browser.mjs';

export function decodeRGB(file) {
  return execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
}

/** → { identical (bytes), maxDiff, diffPixels, pixels, firstDiff:{x,y}|null } (width needed for coordinates). */
export function comparePng(a, b, width = 0) {
  const A = fs.readFileSync(a), B = fs.readFileSync(b);
  if (A.equals(B)) return { identical: true, maxDiff: 0, diffPixels: 0 };
  const ra = decodeRGB(a), rb = decodeRGB(b);
  if (ra.length !== rb.length) return { identical: false, maxDiff: 255, diffPixels: -1, note: `size ${ra.length} vs ${rb.length}` };
  let maxDiff = 0, diffPixels = 0, first = -1;
  for (let i = 0; i < ra.length; i += 3) {
    const d = Math.max(Math.abs(ra[i] - rb[i]), Math.abs(ra[i + 1] - rb[i + 1]), Math.abs(ra[i + 2] - rb[i + 2]));
    if (d) { diffPixels++; if (d > maxDiff) maxDiff = d; if (first < 0) first = i / 3; }
  }
  return { identical: false, maxDiff, diffPixels, pixels: ra.length / 3,
    firstDiff: first >= 0 && width ? { x: first % width, y: Math.floor(first / width) } : null };
}
