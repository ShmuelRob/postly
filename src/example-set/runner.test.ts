import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RenderRequest, RenderResult } from '../contracts/providers/renderer.js';
import { BADGE_KINDS } from '../contracts/design-spec.js';
import { loadExampleSet } from './loader.js';
import { buildGallery } from './runner.js';

const dirs: string[] = [];
async function outDir() {
  const dir = await mkdtemp(join(tmpdir(), 'gallery-'));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A fake renderer that stores one 1x1 file per slide, at a chosen size. */
function fakeRenderer(size = { width: 1080, height: 1350 }, failFor?: string) {
  const requests: RenderRequest[] = [];
  return {
    requests,
    createRenderer: ({ store }: Parameters<Parameters<typeof buildGallery>[0]['createRenderer']>[0]) => ({
      forBusiness: (business: { storagePrefix: string }) => ({
        async render(request: RenderRequest): Promise<RenderResult> {
          requests.push(request);
          if (failFor !== undefined && request.style === failFor) throw new Error('does not fit');
          const result: RenderResult = {};
          for (const network of request.networks) {
            const slides = request.format === 'single' ? 1 : request.photoUrls.length;
            result[network] = [];
            for (let i = 1; i <= slides; i++) {
              const storagePath = `${business.storagePrefix}/${requests.length}/${network}/${i}.jpg`;
              await store.put(storagePath, new Uint8Array([1]), 'image/jpeg');
              result[network].push({ storagePath, ...size, mimeType: 'image/jpeg' });
            }
          }
          return result;
        },
      }),
      close: async () => {},
    }),
  };
}

describe('example-set gallery', () => {
  it('renders every entry in every style for every network and overlay text', { timeout: 30_000 }, async () => {
    const entries = await loadExampleSet();
    const fake = fakeRenderer();
    const { cells, indexPath } = await buildGallery({ createRenderer: fake.createRenderer, outDir: await outDir() });

    const overlays = entries.reduce((n, e) => n + e.expected.overlayTexts.length, 0);
    // Each entry and style also gets one cover per badge kind (WP-94: the human sees the badges).
    expect(cells).toHaveLength(overlays * 3 + entries.length * 3 * BADGE_KINDS.length);
    for (const entry of entries) {
      for (const style of ['clean', 'warm', 'dynamic']) {
        const mine = cells.filter((c) => c.entryId === entry.id && c.style === style);
        expect(mine.filter((c) => !c.badge).map((c) => c.overlayText)).toEqual(entry.expected.overlayTexts);
        expect(mine.flatMap((c) => (c.badge ? [c.badge] : []))).toEqual([...BADGE_KINDS]);
      }
    }
    const withBadge = fake.requests.filter((r) => r.badge);
    expect(withBadge.map((r) => r.format)).toEqual(withBadge.map(() => 'single'));
    expect(withBadge.every((r) => r.badge!.text.length > 0 && r.badge!.text.length <= 8)).toBe(true);
    expect(fake.requests.every((r) => r.networks.includes('instagram') && r.networks.includes('facebook'))).toBe(true);
    expect(cells.every((c) => c.failures.length === 0)).toBe(true);

    const html = await readFile(indexPath, 'utf8');
    for (const entry of entries) {
      expect(html).toContain(entry.profile.name);
      for (const fact of entry.expected.facts) expect(html).toContain(fact.sourceQuote.replace(/"/g, '&quot;'));
    }
    for (const cell of cells) for (const image of cell.images) expect(html).toContain(`src="${image.file}"`);
    await expect(readFile(join(indexPath, '..', cells[0]!.images[0]!.file))).resolves.toHaveLength(1);
  });

  it('marks a render as failing when it breaks a style rule or throws', { timeout: 30_000 }, async () => {
    const [entry] = await loadExampleSet();
    const wrongSize = await buildGallery({
      createRenderer: fakeRenderer({ width: 1080, height: 1080 }).createRenderer,
      entries: [entry!],
      outDir: await outDir(),
    });
    expect(wrongSize.cells[0]!.failures.join()).toContain('expected 1080x1350');

    const thrown = await buildGallery({
      createRenderer: fakeRenderer(undefined, 'warm').createRenderer,
      entries: [entry!],
      outDir: await outDir(),
    });
    const warm = thrown.cells.filter((c) => c.style === 'warm');
    expect(warm.every((c) => c.failures.join().includes('does not fit'))).toBe(true);
    const html = await readFile(thrown.indexPath, 'utf8');
    expect(html).toContain('FAIL');
    expect(html).toContain('PASS');
  });

});
