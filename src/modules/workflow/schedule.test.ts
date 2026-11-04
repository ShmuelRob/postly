import { describe, expect, it } from 'vitest';
import { when } from './schedule-copy.js';
import { isScheduleConfirmation } from './schedule.js';

describe('schedule confirmation text (state-machines.md, Conversation)', () => {
  it.each(['כן', 'כן!', 'מאשר', 'כן, מתאים', 'סבבה תודה', 'OK', '👍', 'יאללה'])('"%s" accepts the times', (text) => {
    expect(isScheduleConfirmation(text)).toBe(true);
  });

  it.each(['', 'תודה', 'כן אבל ביום שני', 'אפשר בשעה 12?', 'לא', 'תעביר לחמישי'])('"%s" does not', (text) => {
    expect(isScheduleConfirmation(text)).toBe(false);
  });
});

describe('time wording', () => {
  it('names the local weekday, date and time', () => {
    expect(when(new Date('2026-11-04T08:00:00.000Z'), 'Asia/Jerusalem')).toBe('יום רביעי 4.11 בשעה 10:00');
  });
});
