import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// CAPTURE=1 turns off HMR and file watching so deterministic captures are not disturbed.
const capture = process.env.CAPTURE === '1';

export default defineConfig({
  root: __dirname,
  server: {
    port: Number(process.env.PORT || 5180),
    strictPort: false,
    hmr: capture ? false : undefined,
    watch: capture ? null : undefined,
  },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: resolve(__dirname, 'index.html') } },
  },
});
