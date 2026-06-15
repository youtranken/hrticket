import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // `@hris/shared` ships CommonJS (dist/index.js, __exportStar re-exports). Vite dev does
  // not pre-bundle linked workspace packages by default, so native-ESM named imports
  // (e.g. TICKET_STATUS_COLOR) fail. Force esbuild to pre-bundle it → named exports become
  // visible. Dev-only; production (Rollup) already resolves the CJS re-exports correctly.
  optimizeDeps: {
    include: ['@hris/shared'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
