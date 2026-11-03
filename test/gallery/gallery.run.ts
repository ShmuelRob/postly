// Builds the example-set gallery: `npm run gallery` writes reports/gallery/index.html.
// It runs under Vitest (vitest.gallery.config.ts) so the TypeScript source loads as is.

import { expect, it } from 'vitest';
import { buildGallery } from '../../src/example-set/runner.js';
import { createDesignRenderer } from '../../src/modules/design/index.js';

it('builds the example-set gallery', { timeout: 30 * 60_000 }, async () => {
  const result = await buildGallery({ createRenderer: createDesignRenderer });
  const failed = result.cells.filter((cell) => cell.failures.length > 0);
  console.log(`Gallery: ${result.indexPath} (${result.cells.length} renders, ${failed.length} fail)`);
  for (const cell of failed) console.log(`FAIL ${cell.entryId} ${cell.style}: ${cell.failures.join('; ')}`);
  // Failing renders are shown in the gallery for the human; the run fails only when nothing rendered.
  expect(result.cells.some((cell) => cell.images.length > 0)).toBe(true);
});
