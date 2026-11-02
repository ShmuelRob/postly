// Pixel comparison for the snapshot tests.

import sharp from 'sharp';

export type ImageDiff = { sizeMismatch: boolean; ratio: number };

/** The share of pixels where any channel differs by more than `tolerance` (0 to 255). */
export async function diffImages(expected: Uint8Array, actual: Uint8Array, tolerance: number): Promise<ImageDiff> {
  const [a, b] = await Promise.all(
    [expected, actual].map((img) => sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true })),
  );
  if (!a || !b || a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return { sizeMismatch: true, ratio: 1 };
  }
  const pixels = a.info.width * a.info.height;
  let different = 0;
  for (let i = 0; i < a.data.length; i += 3) {
    if (
      Math.abs(a.data[i]! - b.data[i]!) > tolerance ||
      Math.abs(a.data[i + 1]! - b.data[i + 1]!) > tolerance ||
      Math.abs(a.data[i + 2]! - b.data[i + 2]!) > tolerance
    ) {
      different++;
    }
  }
  return { sizeMismatch: false, ratio: different / pixels };
}
