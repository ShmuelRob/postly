# תבניות WhatsApp: תקציר

תקציר בעברית של [whatsapp-templates.md](whatsapp-templates.md).

- כל הודעה לבעל העסק מחוץ לחלון 24 השעות של WhatsApp חייבת להיות תבנית שאושרה על ידי Meta.
- התבניות: `weekly_reminder`, `drafts_ready`, `publication_confirmation`, `publication_failed`, `channel_disconnected`, `subscription_cancelled`, `monthly_report`, תבנית התשלום המוצעת `payment_link` (T1), ושלוש תבניות העצירה על אי תשלום (T16): `payment_reminder` (תזכורת עם קישור, `pending`), `payment_failed` (תזכורת ל-`past_due`) ו-`publishing_on_hold` (יום 7, הפרסום נעצר).
- כולן בקטגוריית Utility, בעברית. הנוסחים נלקחו מהקוד (קבצי `*-copy.ts`) והם זמניים (H6); שינוי בנוסח משנה גם את הקוד באותו PR.
- המשתנים נקראים בשם בקוד וממופים לפי הסדר ל-`{{1}}`, `{{2}}` אצל Meta. קישורים יושבים בכפתור URL, לא בגוף ההודעה.
- תהליך האישור: WhatsApp Manager → Message templates → יצירת תבנית Utility בשם המדויק, בעברית, עם ערכי דוגמה; שליחה; תיקון ניסוח אם נדחתה; סימון ברשימת הבדיקה בקובץ.
- סביבות dev ו-stage משתמשות בסימולטור ולא צריכות אישור.
