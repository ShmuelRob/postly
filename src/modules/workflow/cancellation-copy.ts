// Owner-facing templates for cancellation and the monthly report (WP-43). Provisional (H6): drafted
// from the PRD and queued for the human. Bodies to submit for WhatsApp approval; the variables are
// named, the provider maps them to its placeholders.

export const CANCELLED_TEMPLATE = 'subscription_cancelled';
export const CANCELLED_TEMPLATE_BODY =
  'המנוי שלך ל-Postly בוטל, והחיבור לרשתות החברתיות נותק. הנתונים של העסק יימחקו ב-{{deleteAfter}}. אם זו טעות, כתבו לנו כאן.';

export const MONTHLY_REPORT_TEMPLATE = 'monthly_report';
export const MONTHLY_REPORT_TEMPLATE_BODY =
  'הסיכום של Postly ל{{month}}: {{posts}} פוסטים פורסמו, חשיפה {{reach}}, מעורבות {{engagement}} (לייקים, תגובות ושיתופים).';

/** A metric the provider never supplied. */
export const MISSING_METRIC = '-';

/** The deletion date for the owner, in the business's time zone, for example 04.12.2026. */
export function deletionDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('day')}.${part('month')}.${part('year')}`;
}

/** The report's month in Hebrew, for example "אוקטובר 2026". The month is a UTC calendar month. */
export function monthName(from: Date): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(from);
}

/** A number for the owner, with thousands separators. */
export const metric = (value: number | undefined) => (value === undefined ? MISSING_METRIC : value.toLocaleString('en-US'));
