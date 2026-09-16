import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Target API untuk dev proxy (Vite) — hindari localhost agar port mudah diganti.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // mesin kalkulasi harga dipakai bersama client & server (sumber kebenaran sama)
      '@shared': path.resolve(__dirname, '..', 'server', 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.CLIENT_PORT || 5173),
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 4000}`,
        changeOrigin: true,
      },
    },
  },
  preview: { host: '0.0.0.0', allowedHosts: true },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
