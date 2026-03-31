import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.tsx'],
    // Don't try to transform Wagmi/RainbowKit internals — mock them instead
    exclude: ['**/node_modules/**', '**/foundry/**', '**/.next/**'],
  },
  resolve: {
    alias: {
      // mirrors tsconfig paths
      '@':  path.resolve(__dirname, './'),
      '~~': path.resolve(__dirname, './'),
    },
  },
});