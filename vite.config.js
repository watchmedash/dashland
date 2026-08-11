import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so a build runs from wherever it is put rather than only from a
  // server root. GitHub Pages serves this repo under /dashland/, and the
  // desktop wrappers we are heading for (Steam, the Microsoft Store) load the
  // same files off the local filesystem — both need the asset URLs to be
  // relative or every script tag 404s.
  base: './',
  server: { port: 5188, strictPort: true, host: true },
  preview: { port: 4188, strictPort: true },
  build: { target: 'esnext', sourcemap: false },
  worker: { format: 'es' },
});
