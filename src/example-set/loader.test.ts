import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_SET_DIR, ExampleSetError, loadExampleEntry, loadExampleSet } from './loader.js';
import { PlaceholderSpec, placeholderPhotoSvg } from './placeholder-photo.js';

const update = 'השבוע הגיעו אדמוניות, זר ב-120 ₪. פתוחים עד 20:00.';

function validEntry() {
  return {
    provisional: true,
    profile: {
      name: 'פרחי בדיקה',
      field: 'חנות פרחים',
      mainProducts: ['זרים'],
      location: { city: 'כפר סבא', address: 'הנרקיס 1', hours: 'א-ה 9:00-19:00', fulfillment: ['pickup'] },
      differentiator: 'פרחים טריים כל בוקר',
      channels: ['instagram'],
      style: 'warm',
      approverPhone: '+972501234561',
    },
    photos: [
      {
        file: 'photos/1.svg',
        description: 'Bouquet placeholder',
        placeholder: { width: 1080, height: 1350, colors: ['#F7C6D9', '#7A3E5D', '#FFFFFF'], motif: 'petals', seed: 1 },
      },
    ],
    expected: {
      facts: [
        { id: 'price', type: 'price', value: '120 ₪', sourceQuote: 'זר ב-120 ₪' },
        { id: 'hours', type: 'time', value: '20:00', sourceQuote: 'פתוחים עד 20:00' },
      ],
      missingDetails: [],
      overlayTexts: ['אדמוניות טריות'],
    },
  };
}

let root: string;

async function writeEntry(name: string, entry: unknown, options: { update?: string; photos?: boolean } = {}) {
  const dir = join(root, name);
  await mkdir(join(dir, 'photos'), { recursive: true });
  await writeFile(join(dir, 'entry.json'), JSON.stringify(entry, null, 2));
  if (options.update !== '') await writeFile(join(dir, 'weekly-update.txt'), `${options.update ?? update}\n`);
  if (options.photos !== false) {
    const e = entry as ReturnType<typeof validEntry>;
    for (const photo of e.photos ?? []) {
      await writeFile(join(dir, photo.file), placeholderPhotoSvg(PlaceholderSpec.parse(photo.placeholder)));
    }
  }
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'example-set-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadExampleEntry', () => {
  it('loads a valid entry with profile defaults, the update text, and photo paths', async () => {
    const dir = await writeEntry('florist', validEntry());
    const entry = await loadExampleEntry(dir);
    expect(entry.id).toBe('florist');
    expect(entry.provisional).toBe(true);
    expect(entry.profile.languages).toEqual(['he']);
    expect(entry.weeklyUpdate).toBe(update);
    expect(entry.photos[0]?.path).toBe(join(dir, 'photos', '1.svg'));
    expect(entry.expected.facts).toHaveLength(2);
  });

  it('rejects an invalid business profile', async () => {
    const entry = validEntry();
    entry.profile.approverPhone = '050-123456';
    const dir = await writeEntry('florist', entry);
    await expect(loadExampleEntry(dir)).rejects.toThrow(/florist.*profile\.approverPhone/s);
  });

  it('rejects an entry without the provisional flag', async () => {
    const { provisional: _omit, ...entry } = validEntry();
    const dir = await writeEntry('florist', entry);
    await expect(loadExampleEntry(dir)).rejects.toThrow(ExampleSetError);
  });

  it('rejects a missing weekly update', async () => {
    const dir = await writeEntry('florist', validEntry(), { update: '' });
    await expect(loadExampleEntry(dir)).rejects.toThrow(/weekly-update\.txt/);
  });

  it('rejects a fact whose source quote is not verbatim in the update', async () => {
    const entry = validEntry();
    entry.expected.facts[0]!.sourceQuote = 'זר ב-130 ₪';
    const dir = await writeEntry('florist', entry);
    await expect(loadExampleEntry(dir)).rejects.toThrow(/sourceQuote/);
  });

  it('rejects duplicate fact ids', async () => {
    const entry = validEntry();
    entry.expected.facts[1]!.id = 'price';
    const dir = await writeEntry('florist', entry);
    await expect(loadExampleEntry(dir)).rejects.toThrow(ExampleSetError);
  });

  it('rejects a missing photo file', async () => {
    const dir = await writeEntry('florist', validEntry(), { photos: false });
    await expect(loadExampleEntry(dir)).rejects.toThrow(/photos\/1\.svg/);
  });

  it('rejects a photo path that leaves the entry folder', async () => {
    const entry = validEntry();
    entry.photos[0]!.file = '../other/1.svg';
    const dir = await writeEntry('florist', entry, { photos: false });
    await expect(loadExampleEntry(dir)).rejects.toThrow(ExampleSetError);
  });

  it('rejects a placeholder photo that is not an SVG', async () => {
    const entry = validEntry();
    entry.photos[0]!.file = 'photos/1.jpg';
    const dir = await writeEntry('florist', entry);
    await expect(loadExampleEntry(dir)).rejects.toThrow(ExampleSetError);
  });

  it('accepts a real photo without a placeholder spec', async () => {
    const entry = validEntry();
    const { placeholder: _omit, ...photo } = entry.photos[0]!;
    const dir = await writeEntry('florist', { ...entry, provisional: false, photos: [{ ...photo, file: 'photos/1.jpg' }] }, { photos: false });
    await writeFile(join(dir, 'photos', '1.jpg'), 'jpeg bytes');
    const loaded = await loadExampleEntry(dir);
    expect(loaded.photos[0]?.placeholder).toBeUndefined();
  });

  it.each([
    ['longer than 40 characters', 'א'.repeat(41)],
    ['more than two lines', 'שורה\nשורה\nשורה'],
    ['empty', ' '],
  ])('rejects overlay text that is %s', async (_case, text) => {
    const entry = validEntry();
    entry.expected.overlayTexts = [text];
    const dir = await writeEntry('florist', entry);
    await expect(loadExampleEntry(dir)).rejects.toThrow(/overlayTexts/);
  });

  it('accepts overlay text of exactly two lines and 40 characters', async () => {
    const entry = validEntry();
    entry.expected.overlayTexts = [`${'א'.repeat(20)}\n${'ב'.repeat(19)}`];
    const dir = await writeEntry('florist', entry);
    await expect(loadExampleEntry(dir)).resolves.toBeDefined();
  });
});

describe('loadExampleSet', () => {
  it('loads every entry folder in name order', async () => {
    await writeEntry('yoga', validEntry());
    await writeEntry('bakery', validEntry());
    await writeFile(join(root, 'README.md'), '# not an entry');
    const entries = await loadExampleSet(root);
    expect(entries.map((e) => e.id)).toEqual(['bakery', 'yoga']);
  });

  it('reports every broken entry, not only the first', async () => {
    const broken = validEntry();
    broken.profile.style = 'retro';
    await writeEntry('a-broken', broken);
    await writeEntry('b-broken', broken);
    await expect(loadExampleSet(root)).rejects.toThrow(/a-broken[\s\S]*b-broken/);
  });

  it('rejects a folder name that is not a kebab-case slug', async () => {
    await writeEntry('Florist Shop', validEntry());
    await expect(loadExampleSet(root)).rejects.toThrow(/Florist Shop/);
  });
});

describe('the provisional example set', () => {
  const businesses = ['bakery', 'falafel-stand', 'florist', 'hair-salon', 'pet-shop', 'yoga-studio'];

  it('validates every entry', async () => {
    const entries = await loadExampleSet(EXAMPLE_SET_DIR);
    expect(entries.map((e) => e.id)).toEqual(businesses);
  });

  it('marks every entry provisional, in Hebrew, with one update, 3 placeholder photos, facts, and overlay text', async () => {
    for (const entry of await loadExampleSet(EXAMPLE_SET_DIR)) {
      expect(entry.provisional, entry.id).toBe(true);
      expect(entry.profile.languages[0], entry.id).toBe('he');
      expect(entry.weeklyUpdate, entry.id).toMatch(/[֐-׿]/);
      expect(entry.photos, entry.id).toHaveLength(3);
      expect(entry.photos.every((p) => p.placeholder !== undefined), entry.id).toBe(true);
      expect(entry.expected.facts.length, entry.id).toBeGreaterThan(0);
      expect(entry.expected.overlayTexts.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('covers every visual style', async () => {
    const styles = new Set((await loadExampleSet(EXAMPLE_SET_DIR)).map((e) => e.profile.style));
    expect([...styles].sort()).toEqual(['clean', 'dynamic', 'warm']);
  });

  // Set UPDATE_PLACEHOLDERS=1 to rewrite the committed SVGs after changing a spec or the generator.
  it('has committed placeholder photos that match their spec', async () => {
    for (const entry of await loadExampleSet(EXAMPLE_SET_DIR)) {
      for (const photo of entry.photos) {
        const svg = placeholderPhotoSvg(photo.placeholder!);
        if (process.env.UPDATE_PLACEHOLDERS === '1') await writeFile(photo.path, svg);
        // Line endings may differ on a Windows checkout.
        expect((await readFile(photo.path, 'utf8')).replace(/\r\n/g, '\n'), photo.path).toBe(svg);
      }
    }
  });
});

describe('fixture phones', () => {
  it('uses only the fake number 0501234567 in the committed set', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const root = 'fixtures/example-set';
    for (const slug of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const text = readFileSync(join(root, slug.name, 'entry.json'), 'utf8');
      const phones = [...text.matchAll(/\+?\d[\d-]{8,}\d/g)].map((m) => m[0]);
      for (const p of phones) expect(['+972501234567', '050-1234567']).toContain(p);
    }
  });
});
