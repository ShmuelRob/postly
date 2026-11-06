import { describe, expect, it } from 'vitest';
import { counterHtml, counterText } from './carousel.js';
import type { SlideContext } from './styles/types.js';

// design-styles.md, "Photo edits and badge", carousel layout: `numbered` adds a slide counter such as
// 2/5 on every slide after the cover; `standard` adds nothing.

const ctx = (overrides: Partial<SlideContext>): SlideContext =>
  ({
    kind: 'photo',
    canvas: { width: 1080, height: 1350 },
    language: 'he',
    dir: 'rtl',
    palette: { background: '#FFFFFF', text: '#111111', accent: '#2F6BFF' },
    photo: { dataUri: 'data:,', width: 1, height: 1 },
    logo: { kind: 'text', text: 'x' },
    overlayText: '',
    safeArea: 64,
    ...overrides,
  }) as SlideContext;

describe('counterText', () => {
  it('is index/total with Latin digits', () => {
    expect(counterText({ index: 2, total: 5 })).toBe('2/5');
    expect(counterText({ index: 10, total: 10 })).toBe('10/10');
  });
});

describe('counterHtml', () => {
  it('draws nothing unless the layout is numbered and the slide is after the cover', () => {
    expect(counterHtml(ctx({}), 'counter')).toBe('');
    expect(counterHtml(ctx({ slide: { index: 1, total: 3, numbered: true }, kind: 'cover' }), 'counter')).toBe('');
    expect(counterHtml(ctx({ slide: { index: 2, total: 3, numbered: false } }), 'counter')).toBe('');
  });

  it('draws one safe-area counter, a left-to-right number, on a photo slide of a numbered carousel', () => {
    const html = counterHtml(ctx({ slide: { index: 2, total: 3, numbered: true } }), 'counter');
    expect(html).toContain('data-safe="counter"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('2/3');
    expect(html.match(/data-counter/g)).toHaveLength(1);
  });
});
