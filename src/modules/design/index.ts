// Design: renders posts from style templates and produces a file for each network.
// Public surface of the module: other code imports only from this file (see ../README.md).

import { createPlaywrightRasterizer } from './adapters/playwright-rasterizer.js';
import { createSharpImages } from './adapters/sharp-images.js';
import { type AssetLoader, createDesignEngine, type DesignEngine, type FileStore } from './engine.js';
import { styles } from './styles/index.js';

export type { AssetLoader, BusinessRenderContext, DesignEngine, FileStore } from './engine.js';
export { NetworkAccessError, OverlayTextError, RenderError } from './errors.js';
export { renderStyleSamples, type StyleSample, type StyleSampleInput } from './samples.js';

export type DesignRenderer = DesignEngine;

/**
 * The production renderer: Playwright with Chromium and sharp, with the three styles.
 * Call `forBusiness(...)` for a `TemplateRenderer`, and `close()` to stop the browser.
 */
export function createDesignRenderer(deps: { assets: AssetLoader; store: FileStore }): DesignRenderer {
  return createDesignEngine({
    ...deps,
    rasterizer: createPlaywrightRasterizer(),
    images: createSharpImages(),
    styles,
  });
}
