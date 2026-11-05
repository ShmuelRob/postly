import { z } from "zod";
import { HexColor, Network, PostFormat, Url, VisualStyle } from "../common.js";
import {
  BadgeKind,
  BadgeText,
  CarouselLayout,
  PhotoEdit,
} from "../design-spec.js";

export const RenderRequest = z
  .object({
    style: VisualStyle,
    format: PostFormat,
    photoUrls: z.array(Url).min(1).max(10),
    overlayText: z.string(),
    logoUrl: Url.optional(),
    brandColors: z.array(HexColor).max(5),
    networks: z.array(Network).min(1),
    // Proposed with the agent (contracts.md, TemplateRenderer; design-styles.md, Photo edits and
    // badge). Without them a render is exactly as before.
    /** One edit per photo, in `photoUrls` order. */
    edits: z.array(PhotoEdit).optional(),
    /** The badge text is resolved by the caller: the fact's text, or the sticker's fixed word. */
    badge: z.object({ kind: BadgeKind, text: BadgeText }).optional(),
    carouselLayout: CarouselLayout.optional(),
  })
  .refine(
    (r) => r.edits === undefined || r.edits.length === r.photoUrls.length,
    {
      message: "One edit per photo",
      path: ["edits"],
    },
  );
export type RenderRequest = z.infer<typeof RenderRequest>;

export const RenderedFile = z.object({
  storagePath: z.string().min(1),
  width: z.int().positive(),
  height: z.int().positive(),
  mimeType: z.enum(["image/jpeg", "image/png"]),
});

/** One file per image per network; a carousel has several files per network. */
export const RenderResult = z.partialRecord(
  Network,
  z.array(RenderedFile).min(1),
);
export type RenderResult = z.infer<typeof RenderResult>;

export interface TemplateRenderer {
  render(request: RenderRequest): Promise<RenderResult>;
}
