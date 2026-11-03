import { defineConfig } from 'vitest/config';

// `npm run gallery`: renders the example set into reports/gallery/ (see fixtures/example-set/README.md).
export default defineConfig({
  test: {
    include: ['test/gallery/*.run.ts'],
  },
});
