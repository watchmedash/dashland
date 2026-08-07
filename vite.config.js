import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5188, strictPort: true, host: true },
  preview: { port: 4188, strictPort: true },
  build: { target: 'esnext', sourcemap: false },
  worker: { format: 'es' },
});
