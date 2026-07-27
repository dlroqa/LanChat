import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Renderer lives in src/renderer and is built to dist/renderer.
// Electron loads it from the dev server (LANCHAT_DEV) or the built files.
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    // Two documents: the app, and the launch splash shown in its own window
    // while services start. The splash is a real renderer entry rather than a
    // static file in src/main/assets so it can import the app's stylesheet and
    // <Logo> — one mark, not two that can drift apart. Both land in
    // dist/renderer, which is what electron-builder's `files:` allowlist ships.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./src/renderer/index.html', import.meta.url)),
        splash: fileURLToPath(new URL('./src/renderer/splash.html', import.meta.url)),
      },
    },
  },
});
