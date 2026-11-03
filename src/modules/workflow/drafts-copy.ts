// Drafts copy in Hebrew (technical-design.md, Drafts flow). Provisional (H6): queued for the human
// in human-review-queue.md.

export const APPROVE_TITLE = 'אישור';
export const CHANGE_TITLE = 'שינוי';

/** The draft message: the caption, then the factual details to check (PRD, Content safeguards). */
export function draftText(topic: string, caption: { text: string; hashtags: string[] }, details: string[]): string {
  const lines = [`טיוטה: ${topic}`, '', caption.text];
  if (caption.hashtags.length > 0) lines.push('', caption.hashtags.join(' '));
  if (details.length > 0) lines.push('', `פרטים לבדיקה: ${details.join(' · ')}`);
  lines.push('', 'אפשר לאשר או לבקש שינוי.');
  return lines.join('\n');
}

export const carouselSlide = (index: number, total: number) => `שקופית ${index} מתוך ${total}`;

export const photoChoiceQuestion = (count: number, topic: string) =>
  `שלחת ${count} תמונות לפוסט "${topic}". מה לעשות איתן?\n1. קרוסלה: כל התמונות בפוסט אחד\n2. תמונה אחת: הראשונה, והשאר לא ייכנסו\n3. פוסט נפרד לכל תמונה\nאפשר לענות במספר.`;

export const photoChoiceReask = 'לא הבנתי. ענו 1 לקרוסלה, 2 לתמונה אחת או 3 לפוסט נפרד לכל תמונה.';

export const askWhatToChange = 'מה לשנות בטיוטה? כתבו לי במילים.';

export const whichDraft = 'יש כמה טיוטות פתוחות. לחצו "שינוי" מתחת לטיוטה שתרצו לשנות, ואז כתבו מה לשנות.';

export const notAnApproval = 'כדי לאשר טיוטה צריך ללחוץ על "אישור" מתחת לה. הנה הטיוטות שוב:';

export const draftsNeedReview = 'הצוות שלנו עובר על הטיוטות של השבוע ויחזור אליך בקרוב.';

export const handedOff = 'תודה! מישהו מהצוות שלנו ימשיך איתך מכאן.';
