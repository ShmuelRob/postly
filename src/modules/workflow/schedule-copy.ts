// Scheduling and publishing copy in Hebrew (technical-design.md, Scheduling and publishing flow).
// Provisional (H6): queued for the human in human-review-queue.md, including the two template bodies.

import { NETWORK_NAMES } from './drafts-copy.js';

type Network = keyof typeof NETWORK_NAMES;

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** "יום רביעי 4.11 בשעה 10:00", in the business's timezone. */
export function when(at: Date, timezone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!);
  return `יום ${DAYS[weekday]} ${p.day}.${p.month} בשעה ${p.hour}:${p.minute}`;
}

export const networks = (list: Network[]) => list.map((n) => NETWORK_NAMES[n]).join(' ו');

export function proposal(items: { topic: string; at: string }[]): string {
  const lines = ['כל הטיוטות אושרו 🎉 אלה הזמנים שאני מציע לפרסום:', ''];
  items.forEach((item, i) => lines.push(`${i + 1}. "${item.topic}": ${item.at}`));
  lines.push('', "מתאים? כתבו 'כן' ואתזמן. אם תרצו זמנים אחרים, כתבו לי מה מתאים.");
  return lines.join('\n');
}

export function scheduled(items: { topic: string; at: string }[]): string {
  const lines = ['מתוזמן ✅ הפוסטים יעלו בזמנים האלה:'];
  for (const item of items) lines.push(`• "${item.topic}": ${item.at}`);
  lines.push('', 'אשלח לך הודעה כשכל פוסט עולה.');
  return lines.join('\n');
}

export const scheduleChangeHandedOff = 'קיבלתי. מישהו מהצוות שלנו יתאם איתך את הזמנים ויחזור אליך בקרוב.';

export const channelMissing = (missing: Network[]) =>
  `לא הצלחתי לתזמן, כי ${networks(missing)} לא מחובר כרגע. מישהו מהצוות שלנו יעזור לחבר מחדש ויחזור אליך.`;

export const noTimeFits = 'לא מצאתי זמנים מתאימים בשבועות הקרובים לפי הימים והשעות שבחרת. מישהו מהצוות שלנו יתאם איתך.';

/** Short texts that accept the proposed times (times only; a post is approved only by its button). */
export const SCHEDULE_CONFIRM_WORDS = ['כן', 'מאשר', 'מאשרת', 'מאשרים', 'אישור', 'מתאים', 'אוקיי', 'סבבה', 'יאללה', 'ok', 'okay', '👍'];

/**
 * WhatsApp templates (sent outside the 24-hour window). Bodies to submit for approval; the variables
 * are named, the provider maps them to its placeholders.
 */
export const PUBLISHED_TEMPLATE = 'publication_confirmation';
export const PUBLISHED_TEMPLATE_BODY = 'הפוסט "{{topic}}" עלה עכשיו ב{{networks}} ✅';
export const FAILED_TEMPLATE = 'publication_failed';
export const FAILED_TEMPLATE_BODY = 'לא הצלחנו לפרסם את הפוסט "{{topic}}" ב{{failed}}. הצוות שלנו כבר מטפל בזה ויעדכן אותך.';
