// Onboarding conversation copy in Hebrew, the default business language.
// PROVISIONAL (H6): drafted by the agent for the demo and queued for the human in
// docs/human-review-queue.md. Plural address, warm tone, as the profile defaults.

import type { Network, VISUAL_STYLES } from '../../contracts/common.js';

type VisualStyle = (typeof VISUAL_STYLES)[number];
import type { BusinessProfileDraft } from '../../contracts/business-profile.js';

export const PROVISIONAL = true;

export const intro =
  'שלום! אני Postly 👋\n' +
  'אני מנהל בשבילכם את האינסטגרם והפייסבוק של העסק, ישירות מכאן בוואטסאפ: פעם בשבוע אתם שולחים לי מה חדש, ואני מכין פוסטים מעוצבים לאישורכם. שום דבר לא עולה בלי האישור שלכם.\n' +
  'ההיכרות לוקחת בערך 10 דקות. אפשר לענות בכתב או בהודעה קולית.';

export const questions = {
  business: 'נתחיל: איך קוראים לעסק, מה התחום, ומה המוצרים או השירותים העיקריים?',
  location: 'איפה העסק נמצא (עיר וכתובת), מה שעות הפתיחה, והאם יש איסוף עצמי או משלוחים?',
  audience: 'מי הלקוחות שלכם, ומה מייחד את העסק לעומת המתחרים?',
  channels: 'באילו רשתות לפרסם: אינסטגרם, פייסבוק או שתיהן? והאם לפרסם גם בשבת ובחגים?',
} as const;

export const reask = (question: string) => `לא הצלחתי להבין עד הסוף, אפשר לפרט? ${question}`;

export const handoff = 'אני מעביר את השיחה לנציג מהצוות שלנו, שיחזור אליכם בהקדם.';

export const askLogo = "מעולה, הפרופיל כמעט מוכן! יש לכם לוגו? שלחו אותו כתמונה, או כתבו 'אין'.";
export const logoSaved = 'קיבלתי את הלוגו, תודה.';
export const askPhotos = "עכשיו שלחו כמה תמונות של העסק או המוצרים. כשתסיימו כתבו 'סיימתי' (או 'דלג' אם אין כרגע).";
export const photosReceived = (count: number) => `קיבלתי ${count === 1 ? 'תמונה אחת' : `${count} תמונות`}. אפשר לשלוח עוד, או לכתוב 'סיימתי'.`;

export const samplesIntro = 'הכנתי לכם פוסט לדוגמה בכל אחד משלושת הסגנונות:';
export const styleNames: Record<VisualStyle, string> = { clean: 'נקי', warm: 'חם', dynamic: 'דינמי' };
export const sampleCaption: Record<VisualStyle, string> = {
  clean: '1. נקי: טיפוגרפיה בולטת והרבה מרחב לבן',
  warm: '2. חם: גוונים טבעיים ומרקמים',
  dynamic: '3. דינמי: אלמנטים גרפיים נועזים ותחושת תנועה',
};
export const chooseStyle = 'איזה סגנון מתאים לכם? כתבו את המספר או את השם.';
export const styleUnclear = 'לא זיהיתי סגנון. כתבו 1, 2 או 3.';

const networkNames: Record<Network, string> = { instagram: 'אינסטגרם', facebook: 'פייסבוק' };
const list = (items: string[]) => items.join(', ');

export function summary(draft: BusinessProfileDraft): string {
  const lines = ['זה מה שהבנתי:'];
  const add = (label: string, value: string | undefined) => value && lines.push(`• ${label}: ${value}`);
  add('שם', draft.name);
  add('תחום', draft.field);
  add('מוצרים', draft.mainProducts && list(draft.mainProducts));
  if (draft.location) {
    add('כתובת', `${draft.location.address}, ${draft.location.city}`);
    add('שעות', draft.location.hours);
    add('איסוף ומשלוחים', list(draft.location.fulfillment.map((f) => (f === 'pickup' ? 'איסוף עצמי' : 'משלוחים'))));
  }
  add('לקוחות', draft.targetAudience ?? 'תושבי האזור');
  add('מה מייחד', draft.differentiator);
  add('רשתות', draft.channels && list(draft.channels.map((n) => networkNames[n])));
  add('שבת וחגים', draft.schedule?.publishOnShabbatAndHolidays ? 'מפרסמים' : 'לא מפרסמים');
  add('לוגו', draft.brand?.logoAssetId ? 'התקבל' : 'שם העסק בכתב');
  add('סגנון', draft.style && styleNames[draft.style]);
  lines.push('', "הכול נכון? כתבו 'מאשר', או כתבו מה לתקן.");
  return lines.join('\n');
}

export const correctionUnclear = "לא הבנתי מה לתקן. כתבו למשל: 'השעות הן 8:00 עד 14:00', או 'מאשר' אם הכול נכון.";

export const connect = (link: string) =>
  'מצוין! הצעד האחרון: חיבור הרשתות. היכנסו לקישור ואשרו את החיבור ל־Postly, בלי לשתף סיסמה:\n' +
  `${link}\n` +
  'אם חשבון האינסטגרם פרטי, צריך קודם להעביר אותו לחשבון עסקי בהגדרות האינסטגרם. ואם אין לעסק עמוד פייסבוק, צריך ליצור אחד.\n' +
  "כשתסיימו, כתבו לי 'חיברתי'.";

export const notConnected = (link: string) => `עדיין לא רואה חיבור. נסו שוב דרך הקישור:\n${link}\nוכתבו לי כשסיימתם.`;

export const partlyConnected = (missing: Network[], link: string) =>
  `חלק מהרשתות מחוברות. עדיין חסר: ${list(missing.map((n) => networkNames[n]))}. אפשר להשלים דרך הקישור:\n${link}\nוכתבו לי כשסיימתם.`;

export const activated =
  'הכול מחובר, ובדקתי שאפשר לתזמן פוסטים 🎉 העסק פעיל!\n' +
  'מעכשיו, פעם בשבוע שלחו לי מה חדש בעסק, בכתב, בקול או עם תמונות, ואכין לכם טיוטות לאישור.';

/** Owner answers that approve the profile summary (text is enough here; posts need a button). */
export const APPROVAL_WORDS = ['מאשר', 'מאשרת', 'מאשרים', 'אישור', 'כן', 'נכון', 'הכל נכון', 'הכול נכון', 'אוקיי', 'סבבה', 'מעולה'];
export const SKIP_WORDS = ['אין', 'דלג', 'סיימתי', 'סיום', 'לא', 'אין לי', 'בלי'];
