import { describe, expect, it } from 'vitest';
import { mergeDraft, parseStyle } from './onboarding.js';

describe('parseStyle', () => {
  it.each([
    ['1', 'clean'],
    ['2', 'warm'],
    [' 3. ', 'dynamic'],
    ['חם', 'warm'],
    ['הסגנון הנקי', 'clean'],
    ['dynamic', 'dynamic'],
  ])('reads %j as %s', (text, style) => expect(parseStyle(text)).toBe(style));

  it('returns undefined for anything else', () => {
    expect(parseStyle('4')).toBeUndefined();
    expect(parseStyle('לא יודע')).toBeUndefined();
  });
});

describe('mergeDraft', () => {
  it('adds found fields and merges nested objects one level deep', () => {
    const draft = { name: 'א', schedule: { publishOnShabbatAndHolidays: false, days: [0], hours: [] } };
    const merged = mergeDraft(draft, { field: 'מאפייה', schedule: { publishOnShabbatAndHolidays: true, days: [0], hours: ['10:00'] } });
    expect(merged).toEqual({ name: 'א', field: 'מאפייה', schedule: { publishOnShabbatAndHolidays: true, days: [0], hours: ['10:00'] } });
  });

  it('never takes the approver number or the style from a model', () => {
    const merged = mergeDraft({ approverPhone: '+972501234567' }, { approverPhone: '+972509999999', style: 'clean', name: 'ב' });
    expect(merged).toEqual({ approverPhone: '+972501234567', name: 'ב' });
  });
});
