import { expect, it } from 'vitest';
import { LANGUAGES } from '../../contracts/common.js';
import { handOffLine } from './copy.js';

// The hand-off line goes out in the business's first language (review of #119), in the persona's
// feminine voice where the language marks gender (agent.md, A2). PROVISIONAL copy (H6).
it('has a line for every business language, naming the persona', () => {
  for (const language of LANGUAGES) {
    const line = handOffLine('Postly', language);
    expect(line, language).toContain('Postly');
    expect(line.length, language).toBeGreaterThan(20);
  }
  expect(handOffLine('פוסטלי', 'he')).toBe('כאן פוסטלי. אני מעבירה את השיחה לצוות שלנו, ומישהו יחזור אליך בקרוב.');
  expect(handOffLine('Postly', 'en')).toBe("This is Postly. I'm passing this conversation to our team, and someone will get back to you soon.");
  expect(new Set(LANGUAGES.map((l) => handOffLine('X', l))).size).toBe(LANGUAGES.length);
});
