import { describe, expect, it } from 'vitest';
import type { Fact, PlannedPost } from '../../contracts/model-tasks.js';
import { checkPlan, checkQuotes } from './checks.js';

// The code checks the schema cannot express (contracts.md, "Code checks that the schema cannot express").

const fact = (id: string, type: Fact['type'], sourceQuote: string): Fact => ({ id, type, value: sourceQuote, sourceQuote });

describe('checkQuotes', () => {
  const source = { text: 'מבצע על חלות: 2 ב-25 ₪ עד יום שישי.\nלקוחה כתבה: "הבורקס הכי טוב בחולון"', transcript: 'הגיעו  עוגות שמרים חדשות' };

  it('passes when every quote appears word for word in the text or the transcript', () => {
    const facts = [fact('f1', 'price', '2 ב-25 ₪'), fact('f2', 'product', 'עוגות שמרים חדשות'), fact('f3', 'testimonial', 'הבורקס הכי טוב בחולון')];
    expect(checkQuotes({ facts, missingDetails: [] }, source)).toBeNull();
  });

  it('treats whitespace runs and line breaks as one space', () => {
    const facts = [fact('f1', 'product', 'הגיעו עוגות'), fact('f2', 'date', 'יום שישי. לקוחה')];
    expect(checkQuotes({ facts, missingDetails: [] }, source)).toBeNull();
  });

  it('fails a quote that is paraphrased or invented', () => {
    const facts = [fact('f1', 'price', '2 ב-20 ₪')];
    expect(checkQuotes({ facts, missingDetails: [] }, source)).toMatch(/f1.*not found/);
  });

  it('fails a testimonial whose quote is only in the transcript', () => {
    const facts = [fact('f1', 'testimonial', 'עוגות שמרים חדשות')];
    expect(checkQuotes({ facts, missingDetails: [] }, source)).toMatch(/f1.*typed text/);
  });
});

describe('checkPlan', () => {
  const facts = [fact('f1', 'price', 'x'), fact('f2', 'product', 'y')];
  const photo = '0b8f6a54-3a0e-4f7e-9d6b-1d2c3e4f5a6b';
  const post = (over: Partial<PlannedPost> = {}): PlannedPost => ({
    topic: 'מבצע',
    contentType: 'promotions',
    format: 'single',
    factIds: ['f1'],
    mediaAssetIds: [photo],
    brief: 'פוסט על המבצע',
    ...over,
  });
  const ctx = { facts, postsPerWeek: 2, formats: ['single' as const], mediaAssetIds: [photo] };

  it('passes a plan that fits the profile and the update', () => {
    expect(checkPlan([post(), post({ factIds: ['f2'], mediaAssetIds: [] })], ctx)).toBeNull();
  });

  it('fails when the number of posts is not postsPerWeek', () => {
    expect(checkPlan([post(), post(), post()], ctx)).toMatch(/3 posts.*2/);
  });

  it('fails an unknown fact id', () => {
    expect(checkPlan([post(), post({ factIds: ['f9'] })], ctx)).toMatch(/f9/);
  });

  it('fails a format the profile does not allow', () => {
    expect(checkPlan([post(), post({ format: 'carousel' })], ctx)).toMatch(/carousel/);
  });

  it('fails a photo that is not part of the update', () => {
    expect(checkPlan([post(), post({ mediaAssetIds: ['1b8f6a54-3a0e-4f7e-9d6b-1d2c3e4f5a6b'] })], ctx)).toMatch(/1b8f6a54/);
  });
});
