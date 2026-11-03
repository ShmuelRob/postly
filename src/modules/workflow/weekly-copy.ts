// Weekly update copy in Hebrew (technical-design.md, Weekly update flow). Provisional (H6): queued
// for the human in human-review-queue.md.

/** The approved WhatsApp template for the Monday reminder; one variable, `businessName`. */
export const REMINDER_TEMPLATE = 'weekly_reminder';

/** The template body submitted to WhatsApp for approval ({{businessName}} is the business name). */
export const reminderTemplateText = 'היי {{businessName}}, מה חדש השבוע? שלחו לי עדכון קצר, בטקסט, בהקלטה או בתמונות, ואכין לכם את הפוסטים של השבוע.';

export const updateReceived = (posts: number) => `קיבלתי את העדכון, תודה! אני מכין ${posts} פוסטים לשבוע הזה ואשלח לך טיוטות לאישור.`;

export const updateForNextWeek = (posts: number) =>
  `קיבלתי את העדכון, תודה! השבוע הזה כבר נסגר, אז אכין ${posts} פוסטים לשבוע הבא ואשלח לך טיוטות לאישור.`;

export const updateNeedsReview = 'קיבלתי את העדכון, תודה! הצוות שלנו עובר עליו ויחזור אליך בקרוב.';
