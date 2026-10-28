import { defineConfig } from 'vitest/config';

// Runs against a real build output. Use `npm run test:dist` (builds first).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/output/**/*.test.ts'],
  },
});
