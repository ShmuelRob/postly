/** A render request the engine cannot draw within the style rules. */
export class RenderError extends Error {
  override name = 'RenderError';
}

/**
 * The overlay text breaks the length rule: more than 40 characters (`too_long`), or more
 * than 2 lines at the style's minimum size (`does_not_fit`). The caller shortens the text.
 */
export class OverlayTextError extends RenderError {
  override name = 'OverlayTextError';
  constructor(
    readonly code: 'too_long' | 'does_not_fit',
    message: string,
  ) {
    super(message);
  }
}

/** A template tried to load something over the network; rendering never does. */
export class NetworkAccessError extends RenderError {
  override name = 'NetworkAccessError';
  constructor(readonly urls: string[]) {
    super(`Rendering tried to access the network: ${urls.join(', ')}`);
  }
}
