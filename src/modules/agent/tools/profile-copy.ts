import type { AgentProfileField } from '../../../contracts/agent.js';

// The owner's confirmation of a profile change on an active business (agent.md, set_profile_field;
// A7). PROVISIONAL copy (H6), in the persona's voice: feminine Hebrew (A2).

const LABELS: Partial<Record<string, string>> = {
  name: 'שם העסק',
  field: 'תחום',
  mainProducts: 'מוצרים עיקריים',
  location: 'כתובת ושעות',
  targetAudience: 'קהל היעד',
  differentiator: 'מה מייחד את העסק',
  languages: 'שפות',
  tone: 'סגנון הכתיבה',
  contentTypes: 'סוגי תוכן',
  formats: 'פורמטים',
  postsPerWeek: 'פוסטים בשבוע',
  schedule: 'ימים ושעות פרסום',
  brand: 'צבעי המותג',
  callToAction: 'הנעה לפעולה',
  contact: 'פרטי קשר',
  forbiddenTopics: 'נושאים שלא מפרסמים',
  fixedHashtags: 'האשטגים קבועים',
};

/** Code words shown in the owner's language. */
const WORDS: Record<string, string> = { pickup: 'איסוף עצמי', delivery: 'משלוחים', instagram: 'אינסטגרם', facebook: 'פייסבוק' };

function show(value: unknown): string {
  if (Array.isArray(value)) return value.map(show).join(', ');
  if (typeof value === 'boolean') return value ? 'כן' : 'לא';
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).filter((v) => v !== undefined).map(show).join(', ');
  return WORDS[String(value)] ?? String(value);
}

/** "עדכנתי בפרופיל: שעות ...". The value is the whole field as saved. */
export function profileChanged(field: AgentProfileField, saved: unknown): string {
  const top = field.split('.')[0]!;
  return `עדכנתי בפרופיל ${LABELS[top] ?? top}: ${show(saved)}`;
}
