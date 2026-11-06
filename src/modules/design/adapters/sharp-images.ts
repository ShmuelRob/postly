// Image processing with sharp: cover crop, logo fit, and the final JPEG encode.

import sharp from 'sharp';
import type { ImageProcessor } from '../engine.js';
import { PhotoEdit } from '../../../contracts/design-spec.js';
import { insetForRotation, toneLinear } from '../edits.js';
import { coverWindow, JPEG_QUALITY } from '../layout.js';

export type ImageInfo = {
  format: string | undefined;
  width: number | undefined;
  height: number | undefined;
  space: string | undefined;
  hasMetadata: boolean;
};

export function createSharpImages(): ImageProcessor & { inspect(image: Uint8Array): Promise<ImageInfo> } {
  return {
    async coverCrop(photo, box, crop) {
      // rotate() applies the EXIF orientation before measuring.
      const upright = await sharp(photo).rotate().toBuffer({ resolveWithObject: true });
      const { width, height } = upright.info;
      const win = coverWindow({ width, height }, box, crop);
      return sharp(upright.data)
        .resize(win.resize.width, win.resize.height, { fit: 'fill' })
        .extract({ left: win.left, top: win.top, width: box.width, height: box.height })
        .png()
        .toBuffer();
    },

    async edit(photo, edit) {
      // Out-of-range values throw: they are refused, never clamped (agent.md, Photo edits).
      const { rotateDeg, brightness, contrast } = PhotoEdit.parse(edit);
      // Rotate first with no angle to apply the EXIF orientation, as coverCrop does.
      const upright = await sharp(photo).rotate().png().toBuffer({ resolveWithObject: true });
      let image = sharp(upright.data);
      if (rotateDeg) {
        const turned = await sharp(upright.data)
          .rotate(rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer({ resolveWithObject: true });
        const inset = insetForRotation({ width: upright.info.width, height: upright.info.height }, rotateDeg);
        image = sharp(turned.data).extract({
          left: Math.floor((turned.info.width - inset.width) / 2),
          top: Math.floor((turned.info.height - inset.height) / 2),
          width: inset.width,
          height: inset.height,
        });
      }
      if (brightness || contrast) {
        const { gain, offset } = toneLinear({ brightness, contrast });
        image = sharp(await image.png().toBuffer()).removeAlpha().linear([gain, gain, gain], [offset, offset, offset]);
      }
      return image.png().toBuffer();
    },

    async fitLogo(logo, box) {
      const { data, info } = await sharp(logo)
        .resize(box, box, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      return { png: data, width: info.width, height: info.height };
    },

    async toJpeg(png) {
      // sharp drops EXIF, ICC, and XMP unless asked to keep them.
      return sharp(png).flatten({ background: '#FFFFFF' }).toColorspace('srgb').jpeg({ quality: JPEG_QUALITY }).toBuffer();
    },

    async inspect(image) {
      const meta = await sharp(image).metadata();
      return {
        format: meta.format,
        width: meta.width,
        height: meta.height,
        space: meta.space,
        hasMetadata: Boolean(meta.exif ?? meta.icc ?? meta.xmp ?? meta.iptc),
      };
    },
  };
}
