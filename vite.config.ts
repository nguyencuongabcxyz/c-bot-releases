// The windows' pages (gui/), built into dist/, which the app carries inside it. `bun run dev`
// serves them live for `tauri dev`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'gui',
  base: './',
  clearScreen: false,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./gui', import.meta.url)) }, // (as in tsconfig.json)
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'chrome130', // (WebView2 is newer)
    sourcemap: process.env.TAURI_ENV_DEBUG === 'true', // (no maps in a release)
    chunkSizeWarningLimit: 1200, // (three.js)
  },
});
