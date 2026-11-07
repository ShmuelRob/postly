import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the playground UI for the dev sandbox image (the Dockerfile's sandbox target): static files that
// playground/sandbox/main.ts serves next to its API.
export default defineConfig({
  root: fileURLToPath(new URL('../web/', import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL('../../dist/playground/sandbox/web/', import.meta.url)), emptyOutDir: true },
});
