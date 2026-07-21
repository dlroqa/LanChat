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
  },
});
