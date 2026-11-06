// Example-set runner (WP-13): renders every example entry in every style for every
// network through the design module's public surface, checks each render against the
// style rules, and writes a static HTML gallery for the human to judge.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NETWORKS, type Network, VISUAL_STYLES } from '../contracts/common.js';

type VisualStyle = (typeof VISUAL_STYLES)[number];
import { BADGE_KINDS, type BadgeKind, stickerText } from '../contracts/design-spec.js';
import type { RenderRequest, TemplateRenderer } from '../contracts/providers/renderer.js';
import type { AssetLoader, BusinessRenderContext, FileStore } from '../modules/design/index.js';
import { type ExampleEntry, loadExampleSet } from './loader.js';
import { OverlayText } from './schema.js';

export const GALLERY_DIR = 'reports/gallery';

/** Output sizes per network from design-styles.md. */
export const EXPECTED_SIZES: Record<Network, { width: number; height: number }> = {
  instagram: { width: 1080, height: 1350 },
  facebook: { width: 1080, height: 1350 },
};

const ASSET_ORIGIN = 'https://example-set.postly.test';

export interface GalleryImage {
  network: Network;
  /** Path relative to the gallery folder. */
  file: string;
}

export interface GalleryCell {
  entryId: string;
  style: VisualStyle;
  overlayText: string;
  format: RenderRequest['format'];
  /** Set on a cover rendered with this badge kind (the badge cells, WP-94). */
  badge?: BadgeKind;
  images: GalleryImage[];
  /** Style-rule failures; empty when the render passes. */
  failures: string[];
}

export interface GalleryResult {
  entries: ExampleEntry[];
  cells: GalleryCell[];
  indexPath: string;
}

export interface GalleryDeps {
  /** The design module's `forBusiness`, bound to the runner's asset loader and store. */
  createRenderer(deps: { assets: AssetLoader; store: FileStore }): {
    forBusiness(business: BusinessRenderContext): TemplateRenderer;
    close(): Promise<void>;
  };
  entries?: ExampleEntry[];
  outDir?: string;
}

const photoUrl = (entryId: string, index: number) => `${ASSET_ORIGIN}/${entryId}/${index}`;

/**
 * The renders for one entry and style: the first overlay text on the whole post
 * (a carousel when the entry has several photos), and each other overlay text on a
 * single cover. Then one single cover per badge kind, so the human sees every badge in every style.
 */
function requestsFor(entry: ExampleEntry, style: VisualStyle): RenderRequest[] {
  const base = { style, brandColors: entry.profile.brand.colors, networks: [...NETWORKS] };
  const urls = entry.photos.map((_, i) => photoUrl(entry.id, i));
  const covers = entry.expected.overlayTexts.map((overlayText, i) =>
    i === 0 && urls.length > 1
      ? { ...base, format: 'carousel' as const, photoUrls: urls, overlayText }
      : { ...base, format: 'single' as const, photoUrls: [urls[0]!], overlayText },
  );
  const language = entry.profile.languages[0] ?? 'he';
  const badges = BADGE_KINDS.map((kind) => ({
    ...base,
    format: 'single' as const,
    photoUrls: [urls[0]!],
    overlayText: entry.expected.overlayTexts[0]!,
    badge: { kind, text: kind === 'discount' ? '-15%' : kind === 'price' ? '₪29.90' : stickerText(kind, language) },
  }));
  return [...covers, ...badges];
}

/** Checks a render against the style rules the gallery can see from outside the engine. */
function checkRules(request: RenderRequest, result: Awaited<ReturnType<TemplateRenderer['render']>>): string[] {
  const failures: string[] = [];
  const overlay = OverlayText.safeParse(request.overlayText);
  if (!overlay.success) failures.push(...overlay.error.issues.map((issue) => issue.message));
  const slides = request.format === 'single' ? 1 : request.photoUrls.length;
  for (const network of request.networks) {
    const files = result[network] ?? [];
    if (files.length !== slides) failures.push(`${network}: ${files.length} files, expected ${slides}`);
    const size = EXPECTED_SIZES[network];
    for (const file of files) {
      if (file.width !== size.width || file.height !== size.height) {
        failures.push(`${network}: ${file.width}x${file.height}, expected ${size.width}x${size.height}`);
      }
      if (file.mimeType !== 'image/jpeg') failures.push(`${network}: ${file.mimeType}, expected image/jpeg`);
    }
  }
  return failures;
}

export async function buildGallery(deps: GalleryDeps): Promise<GalleryResult> {
  const entries = deps.entries ?? (await loadExampleSet());
  const outDir = deps.outDir ?? GALLERY_DIR;
  const photoPaths = new Map(entries.flatMap((e) => e.photos.map((p, i) => [photoUrl(e.id, i), p.path] as const)));
  const written = new Map<string, Uint8Array>();
  const assets: AssetLoader = {
    async load(url) {
      const path = photoPaths.get(url);
      if (path === undefined) throw new Error(`Unknown asset ${url}`);
      return readFile(path);
    },
  };
  const store: FileStore = {
    async put(path, bytes) {
      written.set(path, bytes);
    },
  };

  const renderer = deps.createRenderer({ assets, store });
  const cells: GalleryCell[] = [];
  try {
    for (const entry of entries) {
      const business: BusinessRenderContext = {
        businessName: entry.profile.name,
        languages: entry.profile.languages,
        storagePrefix: `images/${entry.id}`,
      };
      for (const style of VISUAL_STYLES) {
        for (const request of requestsFor(entry, style)) {
          const cell: GalleryCell = {
            entryId: entry.id,
            style,
            overlayText: request.overlayText,
            format: request.format,
            ...(request.badge ? { badge: request.badge.kind } : {}),
            images: [],
            failures: [],
          };
          try {
            const result = await renderer.forBusiness(business).render(request);
            cell.failures = checkRules(request, result);
            for (const network of request.networks) {
              for (const file of result[network] ?? []) cell.images.push({ network, file: file.storagePath });
            }
          } catch (error) {
            cell.failures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
          }
          cells.push(cell);
        }
      }
    }
  } finally {
    await renderer.close();
  }

  for (const [path, bytes] of written) {
    const target = join(outDir, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
  }
  const indexPath = join(outDir, 'index.html');
  await writeFile(indexPath, renderGallery(entries, cells));
  return { entries, cells, indexPath };
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function renderCell(cell: GalleryCell): string {
  const verdict = cell.failures.length === 0 ? 'pass' : 'fail';
  const images = cell.images
    .map((image) => `<figure><img src="${escape(image.file)}" loading="lazy" alt=""><figcaption>${image.network}</figcaption></figure>`)
    .join('');
  const failures = cell.failures.map((f) => `<li>${escape(f)}</li>`).join('');
  return `<div class="cell ${verdict}" data-style="${cell.style}">
  <div class="verdict">${verdict.toUpperCase()} · ${cell.format}${cell.badge ? ` · badge ${cell.badge}` : ''}</div>
  <p class="overlay" dir="auto">${escape(cell.overlayText)}</p>
  <div class="images">${images}</div>${failures ? `<ul class="failures">${failures}</ul>` : ''}
</div>`;
}

export function renderGallery(entries: ExampleEntry[], cells: GalleryCell[]): string {
  const failed = cells.filter((c) => c.failures.length > 0).length;
  const rows = entries
    .map((entry) => {
      const facts = entry.expected.facts
        .map((f) => `<li><b>${escape(f.type)}</b>: ${escape(String(f.value))} <q dir="auto">${escape(f.sourceQuote)}</q></li>`)
        .join('');
      const missing = entry.expected.missingDetails.map((m) => `<li dir="auto">${escape(m)}</li>`).join('');
      const columns = VISUAL_STYLES.map(
        (style) =>
          `<td>${cells
            .filter((c) => c.entryId === entry.id && c.style === style)
            .map(renderCell)
            .join('')}</td>`,
      ).join('');
      return `<tr id="${entry.id}">
<th><h2 dir="auto">${escape(entry.profile.name)}</h2><p>${escape(entry.id)}${entry.provisional ? ' · provisional' : ''}</p>
<h3>Expected facts</h3><ul>${facts}</ul>
<h3>Missing details</h3>${missing ? `<ul>${missing}</ul>` : '<p>None</p>'}</th>${columns}</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Example-set gallery</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;background:#f6f6f4;color:#1c1c1c}
table{border-collapse:collapse}td,th{vertical-align:top;border:1px solid #ddd;padding:8px;background:#fff}
th{text-align:start;width:260px;font-weight:normal}th h2{margin:0 0 4px}h3{font-size:13px;margin:12px 0 4px}
ul{padding-inline-start:18px;margin:0;font-size:13px}.cell{margin-bottom:12px;padding:6px;border-radius:6px}
.pass{border:2px solid #2e7d32}.fail{border:2px solid #c62828;background:#fff3f3}.verdict{font-weight:700;font-size:12px}
.pass .verdict{color:#2e7d32}.fail .verdict{color:#c62828}.overlay{white-space:pre-line;margin:4px 0}
.images{display:flex;gap:6px;flex-wrap:wrap}figure{margin:0}img{width:180px;display:block}figcaption{font-size:11px;color:#666}
</style></head><body>
<h1>Example-set gallery</h1>
<p>${entries.length} entries × ${VISUAL_STYLES.length} styles · ${cells.length} renders · ${cells.length - failed} pass · ${failed} fail</p>
<table><thead><tr><th>Business</th>${VISUAL_STYLES.map((s) => `<th>${s}</th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody></table></body></html>
`;
}

