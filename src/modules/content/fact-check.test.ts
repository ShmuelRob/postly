import { describe, expect, it } from 'vitest';
import type { Fact } from '../../contracts/model-tasks.js';
import { captionSources, checkCaptions, contentHash, factSources } from './fact-check.js';

const facts: Fact[] = [
  { id: 'f1', type: 'promotion', value: 'מבצע על חלות', sourceQuote: 'מבצע על חלות' },
  { id: 'f2', type: 'price', value: '2 חלות ב-25 ₪', sourceQuote: '2 ב-25 ₪' },
  { id: 'f3', type: 'date', value: 'עד יום שישי', sourceQuote: 'עד יום שישי' },
  { id: 'f4', type: 'discount_percent', value: '15%', sourceQuote: '15% הנחה' },
];
const profile = {
  location: { city: 'חולון', address: 'רחוב הרצל 12', hours: 'א׳-ה׳ 7:00-19:00' },
  contact: { phone: '+972501234567' },
  differentiator: 'בצק שתופח 24 שעות',
};
const context = { planFactIds: ['f1', 'f2', 'f3', 'f4'], facts, profile };
const caption = (text: string, hashtags: string[] = []) => ({ captions: { instagram: { text, hashtags } }, usedFactIds: ['f1', 'f2', 'f3', 'f4'] });

describe('checkCaptions (the code fact check)', () => {
  it('accepts numbers, days, and phones that appear in the used facts or the profile', () => {
    const ok = caption('מבצע על חלות: 2 ב-25 ₪ עד יום שישי, 15% הנחה! רחוב הרצל 12, פתוח 7:00-19:00, בצק 24 שעות. 050-1234567', ['#חולון']);
    expect(checkCaptions(ok, context)).toBeNull();
  });

  it('rejects a price that does not match its source', () => {
    expect(checkCaptions(caption('2 חלות ב-20 ₪ עד יום שישי'), context)).toMatch(/20/);
  });

  it('rejects a discount, a time, or a date with no source', () => {
    expect(checkCaptions(caption('20% הנחה'), context)).toMatch(/20/);
    expect(checkCaptions(caption('פתוח עד 21:00'), context)).toMatch(/21:00/);
    expect(checkCaptions(caption('רק ב-12/11'), context)).toMatch(/12\/11/);
  });

  it('rejects a weekday name with no source', () => {
    expect(checkCaptions(caption('המבצע עד יום חמישי'), context)).toMatch(/חמישי/);
  });

  it('rejects a phone number that is not the business phone', () => {
    expect(checkCaptions(caption('הזמנות: 052-7654321'), context)).toMatch(/0527654321/);
    expect(checkCaptions(caption('הזמנות: +972501234567'), context)).toBeNull();
  });

  it('checks hashtags and every network caption', () => {
    expect(checkCaptions(caption('מבצע', ['#מבצע30']), context)).toMatch(/30/);
    const two = { captions: { instagram: { text: 'מבצע', hashtags: [] }, facebook: { text: '3 ב-25', hashtags: [] } }, usedFactIds: ['f2'] };
    expect(checkCaptions(two, context)).toMatch(/facebook.*3/);
  });

  it('counts only the used facts as sources, and only facts the plan named', () => {
    expect(checkCaptions({ ...caption('2 ב-25 ₪'), usedFactIds: ['f1'] }, context)).toMatch(/has no source/);
    expect(checkCaptions({ ...caption('מבצע'), usedFactIds: ['f9'] }, context)).toMatch(/f9/);
    expect(checkCaptions({ ...caption('מבצע'), usedFactIds: ['f2'] }, { ...context, planFactIds: ['f1'] })).toMatch(/f2/);
  });
});

describe('factSources', () => {
  it('lists the used facts', () => {
    expect(factSources(['f2'], facts)).toEqual([{ factId: 'f2', type: 'price', value: '2 חלות ב-25 ₪', sourceQuote: '2 ב-25 ₪' }]);
  });
});

describe('captionSources', () => {
  it('collects the used facts and the profile details', () => {
    expect(captionSources(['f2'], facts, profile)).toContain('2 ב-25 ₪');
    expect(captionSources([], facts, profile)).toContain('רחוב הרצל 12');
  });
});

describe('contentHash', () => {
  const version = { format: 'single' as const, captions: { instagram: { text: 'א', hashtags: ['#ב'] } }, renderedMedia: { instagram: ['3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e'] } };

  it('is a lowercase hex SHA-256 that ignores key order', () => {
    const hash = contentHash(version);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({ renderedMedia: version.renderedMedia, captions: { instagram: { hashtags: ['#ב'], text: 'א' } }, format: 'single' })).toBe(hash);
  });

  it('changes with any caption, media, or format change', () => {
    const hash = contentHash(version);
    expect(contentHash({ ...version, format: 'carousel' })).not.toBe(hash);
    expect(contentHash({ ...version, captions: { instagram: { text: 'א!', hashtags: ['#ב'] } } })).not.toBe(hash);
    expect(contentHash({ ...version, renderedMedia: { facebook: version.renderedMedia.instagram } })).not.toBe(hash);
  });
});
