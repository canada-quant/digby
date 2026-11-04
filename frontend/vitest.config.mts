import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
    // Minimal view (2026-10-16, lib/view-mode.ts): suites render the FULL (admin Debug) view unless a test pins the
    // minimal one with __setViewModeForTests — the unauthenticated default would otherwise be minimal everywhere.
    env: { NEXT_PUBLIC_MINIMAL_VIEW_DISABLED: '1' },
  },
});
