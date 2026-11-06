import { describe, expect, it } from 'vitest';
import type { Fact } from '../../contracts/model-tasks.js';
import type { DesignSpec } from '../../contracts/design-spec.js';
import { captionSources, checkCaptions, checkDesign, contentHash, factSources } from './fact-check.js';

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

  it('matches each detail to a source of its own type, not to any number', () => {
    // The address has 12 and the differentiator 24, but neither is a price, a time, or a discount.
    expect(checkCaptions(caption('חלה ב-12 ₪'), context)).toMatch(/price.*12/);
    expect(checkCaptions(caption('24% הנחה'), context)).toMatch(/discount.*24/);
    expect(checkCaptions(caption('פתוח עד 12:00'), context)).toMatch(/time.*12:00/);
    // The same numbers in their own roles pass: a house number, and the price from the price fact.
    expect(checkCaptions(caption('רחוב הרצל 12, 2 ב-25 ₪, 15% הנחה'), context)).toBeNull();
  });

  it('rejects a weekday name with no source', () => {
    // The hours' range א׳-ה׳ vouches for Sunday to Thursday, but not for Saturday.
    expect(checkCaptions(caption('המבצע עד יום שבת'), context)).toMatch(/שבת/);
    expect(checkCaptions(caption('המבצע עד יום חמישי'), context)).toBeNull();
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

describe('checkCaptions: Hebrew details written in words (T8)', () => {
  const f: Fact[] = [
    { id: 'p', type: 'price', value: 'מגש בורקס ב-45 ₪', sourceQuote: 'מגש בורקס ב-45 ₪' },
    { id: 'd', type: 'discount_percent', value: '20%', sourceQuote: '20% הנחה' },
    { id: 'dt', type: 'date', value: '15.11', sourceQuote: 'עד 15.11' },
    { id: 't', type: 'time', value: '20:00', sourceQuote: 'פתוחים עד 20:00' },
    { id: 'w', type: 'date', value: 'ביום רביעי', sourceQuote: 'ביום רביעי' },
  ];
  const ctx = { planFactIds: f.map((x) => x.id), facts: f, profile: { location: { hours: 'ראשון עד חמישי 8:00-20:00' } } };
  const check = (text: string) => checkCaptions({ captions: { instagram: { text, hashtags: [] } }, usedFactIds: f.map((x) => x.id) }, ctx);

  it.each([
    'מגש בורקס ב-45 ₪ בלבד, עד 15.11',
    'מגש בורקס בארבעים וחמישה שקלים בלבד!',
    'מגש בורקס כארבעים וחמישה שקלים',
    'עוגה, ועשרים אחוז הנחה',
    'רק ארבעים וחמישה ש"ח למגש שלם 🥐',
    'עשרים אחוז הנחה על כל המגשים',
    '20 אחוז הנחה, עד חמישה עשר בנובמבר',
    'המבצע בתוקף עד ה-15 בנובמבר',
    'נתראה ביום רביעי! פתוחים עד השעה 20:00',
    'פתוחים עד השעה שמונה בערב',
    'מחכים לכם בשעה 8 בבוקר עם בורקס חם',
    'פעם אחת טועמים ולא שוכחים. אחד הטעמים הכי אהובים עלינו',
    'שני סוגי מילוי, שלוש דקות הליכה מהתחנה',
    'טעים מאה אחוז, 100% טבעי',
    'בחמישי אנחנו פתוחים כרגיל',
    'יום ה׳ כרגיל, ובשני טעמים חדשים',
  ])('passes a realistic caption: %s', (text) => {
    expect(check(text)).toBeNull();
  });

  it.each([
    ['מגש בורקס בארבעים שקלים בלבד!', /price "40"/],
    ['רק חמישים ש"ח למגש', /price "50"/],
    ['מאה ועשרים ₪ לסלסלה', /price "120"/],
    ['שלושים אחוז הנחה על הכול', /discount "30"/],
    ['30 אחוז הנחה', /discount "30"/],
    ['100% הנחה על המגש השני', /discount "100"/],
    ['הנחה של 100% למצטרפים', /discount "100"/],
    ['מאה אחוז הנחה', /discount "100"/],
    ['מגש בורקס ושלושים שקלים לעוגה', /price "30"/],
    ['רק כחמישים ש"ח', /price "50"/],
    ['וחמישים אחוז הנחה', /discount "50"/],
    ['המבצע עד שישה עשר בנובמבר', /date "16\/11"/],
    ['המבצע עד ה-16 בנובמבר', /date "16\/11"/],
    ['המבצע עד הראשון בדצמבר', /date "1\/12"/],
    ['פתוחים עד השעה תשע בערב', /time "21:00"/],
    ['פתוחים עד השעה 21:00', /time "21:00"/],
    ['נתראה בשישי!', /שישי/],
    ['נתראה ביום ו׳', /שישי/],
    ['נתראה בשבת', /שבת/],
  ])('blocks a mismatch: %s', (text, error) => {
    expect(check(text)).toMatch(error);
  });

  it('reads written amounts up to the thousands', () => {
    const big: Fact[] = [{ id: 'x', type: 'price', value: 'עוגת חתונה 1250 ₪', sourceQuote: 'עוגת חתונה 1250 ₪' }];
    const run = (text: string) => checkCaptions({ captions: { instagram: { text, hashtags: [] } }, usedFactIds: ['x'] }, { planFactIds: ['x'], facts: big, profile: {} });
    expect(run('עוגת חתונה באלף מאתיים וחמישים שקלים')).toBeNull();
    expect(run('עוגת חתונה באלף ומאתיים ₪')).toMatch(/price "1200"/);
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

describe('checkDesign (title and badge fact check)', () => {
  const design = (title: string, badge?: DesignSpec['badge']) => ({ title, ...(badge ? { badge } : {}) });
  const ctx = { ...context, usedFactIds: ['f1', 'f2', 'f3', 'f4'], holidayInWeek: false };

  it('accepts a title whose details have sources, and a post with no badge', () => {
    expect(checkDesign(design('מבצע על חלות\nעד יום שישי'), ctx)).toBeNull();
    expect(checkDesign(design('15% הנחה על חלות'), ctx)).toBeNull();
  });

  it('refuses a title with a price, discount, time or date that has no source', () => {
    expect(checkDesign(design('חלות ב-20 ₪'), ctx)).toMatchObject({ reason: 'fact_mismatch', detail: expect.stringMatching(/title.*20/) });
    expect(checkDesign(design('30% הנחה'), ctx)).toMatchObject({ reason: 'fact_mismatch' });
    expect(checkDesign(design('נפתחים ב-9:00'), ctx)).toMatchObject({ reason: 'fact_mismatch' });
  });

  it('only the facts the post used vouch for its title', () => {
    expect(checkDesign(design('15% הנחה'), { ...ctx, usedFactIds: ['f1'] })).toMatchObject({ reason: 'fact_mismatch' });
  });

  describe('discount badge', () => {
    const badge = { kind: 'discount' as const, text: '-15%', factId: 'f4' };
    it('equals a recorded discount fact the post used', () => {
      expect(checkDesign(design('חלות', badge), ctx)).toBeNull();
    });
    it('is refused with another number, an unknown or unused fact, or a fact of another type', () => {
      expect(checkDesign(design('חלות', { ...badge, text: '-20%' }), ctx)).toMatchObject({ reason: 'fact_mismatch' });
      expect(checkDesign(design('חלות', { ...badge, factId: 'nope' }), ctx)).toMatchObject({ reason: 'fact_mismatch' });
      expect(checkDesign(design('חלות', badge), { ...ctx, usedFactIds: ['f1'] })).toMatchObject({ reason: 'fact_mismatch' });
      expect(checkDesign(design('חלות', { ...badge, factId: 'f2' }), ctx)).toMatchObject({ reason: 'fact_mismatch' });
    });
    it('is refused when its text is not a number with the sign in front and the % after it', () => {
      for (const text of ['15%', '-15', '15% off', '-%15']) {
        expect(checkDesign(design('חלות', { ...badge, text }), ctx), text).toMatchObject({ reason: 'badge_invalid' });
      }
    });
  });

  describe('price badge', () => {
    const facts2: Fact[] = [...facts, { id: 'f5', type: 'price', value: '29.90 ₪', sourceQuote: '29.90 ₪' }];
    const c = { ...ctx, facts: facts2, planFactIds: [...ctx.planFactIds, 'f5'], usedFactIds: [...ctx.usedFactIds, 'f5'] };
    it('equals a recorded price fact the post used', () => {
      expect(checkDesign(design('חלות', { kind: 'price', text: '₪29.90', factId: 'f5' }), c)).toBeNull();
    });
    it('is refused with another amount, or without the sign of the currency', () => {
      expect(checkDesign(design('חלות', { kind: 'price', text: '₪25.90', factId: 'f5' }), c)).toMatchObject({ reason: 'fact_mismatch' });
      expect(checkDesign(design('חלות', { kind: 'price', text: '29.90', factId: 'f5' }), c)).toMatchObject({ reason: 'badge_invalid' });
    });
  });

  describe('stickers', () => {
    it('new needs no fact', () => {
      expect(checkDesign(design('חלות', { kind: 'new' }), ctx)).toBeNull();
    });
    it('sale needs a recorded promotion or discount fact in the post', () => {
      expect(checkDesign(design('חלות', { kind: 'sale' }), ctx)).toBeNull();
      expect(checkDesign(design('חלות', { kind: 'sale' }), { ...ctx, usedFactIds: ['f3'] })).toMatchObject({ reason: 'fact_mismatch', detail: expect.stringMatching(/sale/) });
    });
    it('holiday only when the post week holds a holiday', () => {
      expect(checkDesign(design('חלות', { kind: 'holiday' }), ctx)).toMatchObject({ reason: 'fact_mismatch', detail: expect.stringMatching(/holiday/) });
      expect(checkDesign(design('חלות', { kind: 'holiday' }), { ...ctx, holidayInWeek: true })).toBeNull();
    });
  });
});
