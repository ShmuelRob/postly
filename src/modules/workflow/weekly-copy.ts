// Weekly update copy in Hebrew (technical-design.md, Weekly update flow). Provisional (H6): queued
// for the human in human-review-queue.md.

/** The approved WhatsApp template for the Monday reminder; one variable, `businessName`. */
export const REMINDER_TEMPLATE = 'weekly_reminder';

/** The template body submitted to WhatsApp for approval ({{businessName}} is the business name). */
export const reminderTemplateText = 'היי {{businessName}}, מה חדש השבוע? שלחו לי עדכון קצר, בטקסט, בהקלטה או בתמונות, ואכין לכם את הפוסטים של השבוע.';

export const updateReceived = (posts: number) => `קיבלתי את העדכון, תודה! אני מכין ${posts} פוסטים לשבוע הזה ואשלח לך טיוטות לאישור.`;

export const updateForNextWeek = (posts: number) =>
  `קיבלתי את העדכון, תודה! השבוע הזה כבר נסגר, אז אכין ${posts} פוסטים לשבוע הבא ואשלח לך טיוטות לאישור.`;

/** A second update after this week's update was already handled (not after the cutoff). */
export const updateCountsForNextWeek = (posts: number) =>
  `קיבלתי, תודה! לשבוע הזה כבר יש עדכון, אז העדכון הזה ייכנס לשבוע הבא: אכין ${posts} פוסטים ואשלח לך טיוטות לאישור.`;

export const updateNeedsReview = 'קיבלתי את העדכון, תודה! הצוות שלנו עובר עליו ויחזור אליך בקרוב.';

/** A failure before the message was recognized: a person answers, nothing claims an update arrived. */
export const handoffNeutral = 'תודה על ההודעה! מישהו מהצוות שלנו יחזור אליך בקרוב.';

/** A second update while the last one is still being drafted. */
export const stillWorking = 'אני עדיין מכין את הטיוטות מהעדכון הקודם. כשהן יגיעו, אפשר לבקש בהן שינויים ולהוסיף את הפרטים החדשים.';

/** An update for next week when next week's update is already in. */
export const nextWeekAlreadyIn = 'כבר יש לי עדכון לשבוע הבא. אם משהו השתנה, אפשר לבקש שינוי כשהטיוטות יגיעו.';
