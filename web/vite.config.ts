import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths so the build runs from localhost or any hosted subfolder.
  base: './',
  worker: { format: 'es' },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
