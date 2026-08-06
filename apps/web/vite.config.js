import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API serves the built SPA from apps/web/dist (see apps/api/src/app.js) and owns
// every /api and /auth path, so dev proxies both to a locally running API — same-origin
// in dev as in prod, which is what keeps the httpOnly session cookie working.
export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Source maps stay off in the shipped bundle but the build must not silently
    // swallow oversized chunks — the vendor split below keeps this honest.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          motion: ['framer-motion'],
          charts: ['chart.js'],
          sheets: ['xlsx'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/auth': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/downloads': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
});
