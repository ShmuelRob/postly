/**
 * A stand-in for the model's intent_detection on the model simulator, so the human can type a weekly
 * update or a change in free Hebrew (review queue item 20, WP-31 follow-up f). Not product logic:
 * simple word rules, enough to play the flows. The real classification is the model's.
 */
export function playgroundIntent(input: { text: string; step: string; draftsOpen: boolean }): {
  intent: 'weekly_update' | 'change_request' | 'question' | 'support_request' | 'other';
  confidence: number;
} {
  const text = input.text.trim();
  if (/נציג|בן אדם|אדם אמיתי/u.test(text)) return { intent: 'support_request', confidence: 0.8 };
  if (input.draftsOpen) {
    // "Sounds good" is not a change; anything that asks for something different is.
    if (/^(נשמע טוב|מעולה|יפה|סבבה|אהבתי|תודה)[!. ]*$/u.test(text)) return { intent: 'other', confidence: 0.7 };
    return { intent: 'change_request', confidence: 0.8 };
  }
  if (text.endsWith('?')) return { intent: 'question', confidence: 0.6 };
  if (text.length >= 8 && input.step === 'idle') return { intent: 'weekly_update', confidence: 0.8 };
  return { intent: 'other', confidence: 0.5 };
}
