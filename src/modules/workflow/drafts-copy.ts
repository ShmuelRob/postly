// Drafts copy in Hebrew (technical-design.md, Drafts flow). Provisional (H6): queued for the human
// in human-review-queue.md.

export const APPROVE_TITLE = 'אישור';
export const CHANGE_TITLE = 'שינוי';

export const NETWORK_NAMES = { instagram: 'אינסטגרם', facebook: 'פייסבוק' } as const;

type Caption = { text: string; hashtags: string[] };

/**
 * The draft message: every caption the Approve button covers, then the factual details to check (PRD,
 * Content safeguards). Identical captions are shown once; different ones each under its network.
 */
export function draftText(topic: string, captions: { network: keyof typeof NETWORK_NAMES; caption: Caption }[], details: string[]): string {
  const lines = [`טיוטה: ${topic}`];
  const same = captions.every((c) => c.caption.text === captions[0]!.caption.text && c.caption.hashtags.join(' ') === captions[0]!.caption.hashtags.join(' '));
  for (const { network, caption } of same ? captions.slice(0, 1) : captions) {
    lines.push('');
    if (!same) lines.push(`${NETWORK_NAMES[network]}:`);
    lines.push(caption.text);
    if (caption.hashtags.length > 0) lines.push(caption.hashtags.join(' '));
  }
  if (details.length > 0) lines.push('', `פרטים לבדיקה: ${details.join(' · ')}`);
  lines.push('', 'אפשר לאשר או לבקש שינוי.');
  return lines.join('\n');
}

export const carouselSlide = (index: number, total: number) => `שקופית ${index} מתוך ${total}`;

/** A render for another network, shown before the buttons so the owner sees everything a tap approves. */
export const networkRender = (network: keyof typeof NETWORK_NAMES, index: number, total: number) =>
  total > 1 ? `העיצוב ל${NETWORK_NAMES[network]}, שקופית ${index} מתוך ${total}` : `העיצוב ל${NETWORK_NAMES[network]}`;

export const photoChoiceQuestion = (count: number, topic: string) =>
  `שלחת ${count} תמונות לפוסט "${topic}". מה לעשות איתן?\n1. קרוסלה: כל התמונות בפוסט אחד\n2. תמונה אחת: הראשונה, והשאר לא ייכנסו\n3. פוסט נפרד לכל תמונה\nאפשר לענות במספר.`;

export const photoChoiceReask = 'לא הבנתי. ענו 1 לקרוסלה, 2 לתמונה אחת או 3 לפוסט נפרד לכל תמונה.';

export const askWhatToChange = 'מה לשנות בטיוטה? כתבו לי במילים.';

export const whichDraft = 'יש כמה טיוטות פתוחות. לחצו "שינוי" מתחת לטיוטה שתרצו לשנות, ואז כתבו מה לשנות.';

export const notAnApproval = 'כדי לאשר טיוטה צריך ללחוץ על "אישור" מתחת לה. הנה הטיוטות שוב:';

export const draftsNeedReview = 'הצוות שלנו עובר על הטיוטות של השבוע ויחזור אליך בקרוב.';

export const handedOff = 'תודה! מישהו מהצוות שלנו ימשיך איתך מכאן.';
