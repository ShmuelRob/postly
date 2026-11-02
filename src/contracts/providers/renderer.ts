import { z } from 'zod';
import { HexColor, Network, PostFormat, Url, VisualStyle } from '../common.js';

export const RenderRequest = z.object({
  style: VisualStyle,
  format: PostFormat,
  photoUrls: z.array(Url).min(1).max(10),
  overlayText: z.string(),
  logoUrl: Url.optional(),
  brandColors: z.array(HexColor).max(5),
  networks: z.array(Network).min(1),
});
export type RenderRequest = z.infer<typeof RenderRequest>;

export const RenderedFile = z.object({
  storagePath: z.string().min(1),
  width: z.int().positive(),
  height: z.int().positive(),
  mimeType: z.enum(['image/jpeg', 'image/png']),
});

/** One file per image per network; a carousel has several files per network. */
export const RenderResult = z.partialRecord(Network, z.array(RenderedFile).min(1));
export type RenderResult = z.infer<typeof RenderResult>;

export interface TemplateRenderer {
  render(request: RenderRequest): Promise<RenderResult>;
}
