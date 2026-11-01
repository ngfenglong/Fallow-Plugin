import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Root is src/ui so the HTML entries emit at dist/dashboard/index.html and
// dist/popup/index.html. The service worker is a third entry emitted at the
// stable path dist/background.js (no hash). public/ is copied verbatim.
export default defineConfig({
  root: r('./src/ui'),
  publicDir: r('./public'),
  plugins: [react()],
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        background: r('./src/background/index.ts'),
        dashboard: r('./src/ui/dashboard/index.html'),
        popup: r('./src/ui/popup/index.html'),
      },
      output: {
        format: 'es',
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
