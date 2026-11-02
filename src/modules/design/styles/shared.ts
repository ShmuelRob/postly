import { escapeHtml, type SlideContext } from './types.js';

/** The logo image, or the business name when there is none, marked as a safe-area element. */
export function logoHtml(ctx: SlideContext, className: string): string {
  const { logo } = ctx;
  if (logo.kind === 'image') {
    return `<img class="${className}" data-safe="logo" src="${logo.dataUri}" width="${logo.width}" height="${logo.height}" alt="">`;
  }
  return `<div class="${className} logo-text" data-safe="logo">${escapeHtml(logo.text)}</div>`;
}

export function photoHtml(ctx: SlideContext, className: string): string {
  return `<img class="${className}" src="${ctx.photo.dataUri}" width="${ctx.photo.width}" height="${ctx.photo.height}" alt="">`;
}

export function overlayHtml(ctx: SlideContext, className: string): string {
  if (ctx.overlayText === '') return '';
  return `<div class="${className}" data-overlay data-safe="overlay">${escapeHtml(ctx.overlayText)}</div>`;
}
