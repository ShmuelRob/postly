// Owner-facing templates for cancellation and the monthly report (WP-43). Provisional (H6): drafted
// from the PRD and queued for the human. Since 2026-11-07 `subscription_cancelled` says the data is kept
// (cancellation archives, it never deletes) and has no variables; docs/review-queue/pr-150.md. Bodies to submit for WhatsApp approval; the variables are
// named, the provider maps them to its placeholders.

export const CANCELLED_TEMPLATE = 'subscription_cancelled';
export const CANCELLED_TEMPLATE_BODY =
  'המנוי שלך ל-Postly בוטל, והחיבור לרשתות החברתיות נותק. הנתונים של העסק נשמרים, ואפשר לבקש מאיתנו למחוק אותם. אם זו טעות או שתרצו שנמחק את הנתונים, כתבו לנו כאן.';

export const MONTHLY_REPORT_TEMPLATE = 'monthly_report';
export const MONTHLY_REPORT_TEMPLATE_BODY =
  'הסיכום של Postly ל{{month}}: {{posts}} פוסטים פורסמו, חשיפה {{reach}}, מעורבות {{engagement}} (לייקים, תגובות ושיתופים).';

/** A metric the provider never supplied. */
export const MISSING_METRIC = '-';

/** The report's month in Hebrew, for example "אוקטובר 2026", in the business's time zone. */
export function monthName(from: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone, month: 'long', year: 'numeric' }).format(from);
}

/** A number for the owner, with thousands separators. */
export const metric = (value: number | undefined) => (value === undefined ? MISSING_METRIC : value.toLocaleString('en-US'));
