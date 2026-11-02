// Image processing with sharp: cover crop, logo fit, and the final JPEG encode.

import sharp from 'sharp';
import type { ImageProcessor } from '../engine.js';
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
