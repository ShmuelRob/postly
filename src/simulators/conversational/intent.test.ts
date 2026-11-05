import { describe, expect, it } from 'vitest';
import { playgroundIntent } from './intent.js';

describe('playgroundIntent', () => {
  it('reads a typed update while idle as a weekly update', () => {
    expect(playgroundIntent({ text: 'השבוע מבצע על חלות: 2 ב-25 ₪', step: 'idle', draftsOpen: false }).intent).toBe('weekly_update');
  });

  it('reads a request on open drafts as a change, and praise as other', () => {
    expect(playgroundIntent({ text: 'בלי סימני קריאה', step: 'reviewing_drafts', draftsOpen: true }).intent).toBe('change_request');
    expect(playgroundIntent({ text: 'נשמע טוב!', step: 'reviewing_drafts', draftsOpen: true }).intent).toBe('other');
  });

  it('keeps questions and short texts out of the update path', () => {
    expect(playgroundIntent({ text: 'מתי זה יוצא?', step: 'idle', draftsOpen: false }).intent).toBe('question');
    expect(playgroundIntent({ text: 'היי', step: 'idle', draftsOpen: false }).intent).toBe('other');
  });
});
