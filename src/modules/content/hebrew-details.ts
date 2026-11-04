// Hebrew factual details written in words (technical-design.md, Drafts flow, "Hebrew details in
// words"). `normalizeHebrewDetails` rewrites them into the digit forms the fact check reads, and
// only where a factual marker follows (a currency, אחוז, a month) or precedes (בשעה), so ordinary
// prose such as "פעם אחת" is never read as a number.

const H = String.raw`\u0590-\u05FF`;
const START = String.raw`(?<![${H}\w])`;
const END = String.raw`(?![${H}])`;

const UNITS: Record<string, number> = {
  אחד: 1, אחת: 1,
  שניים: 2, שנים: 2, שתיים: 2, שתים: 2, שני: 2, שתי: 2,
  שלושה: 3, שלוש: 3, שלש: 3, שלושת: 3,
  ארבעה: 4, ארבע: 4, ארבעת: 4,
  חמישה: 5, חמש: 5, חמשת: 5,
  שישה: 6, שש: 6, ששת: 6,
  שבעה: 7, שבע: 7, שבעת: 7,
  שמונה: 8, שמונת: 8,
  תשעה: 9, תשע: 9, תשעת: 9,
  עשרה: 10, עשר: 10, עשרת: 10,
};
const TENS: Record<string, number> = { עשרים: 20, שלושים: 30, ארבעים: 40, חמישים: 50, שישים: 60, שבעים: 70, שמונים: 80, תשעים: 90 };
const BIG = ['מאה', 'מאתיים', 'מאות', 'אלף', 'אלפיים', 'אלפים'];
const ORDINALS: Record<string, number> = { ראשון: 1, שני: 2, שלישי: 3, רביעי: 4, חמישי: 5, שישי: 6, שביעי: 7, שמיני: 8, תשיעי: 9, עשירי: 10 };
const MONTHS: Record<string, number> = {
  ינואר: 1, פברואר: 2, מרץ: 3, מרס: 3, אפריל: 4, מאי: 5, יוני: 6, יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12,
};
export const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const;
const DAY_LETTERS = 'אבגדהוש';

const alt = (words: string[]) => [...words].sort((a, b) => b.length - a.length).join('|');
const NUMBER_WORD = alt([...Object.keys(UNITS), ...Object.keys(TENS), ...BIG]);
/** A run of number words: an optional ב/ל/מ/ה prefix on the first, ו before any later one. */
const PHRASE = String.raw`${START}([בלמה]?)((?:${NUMBER_WORD})${END}(?:\s+ו?(?:${NUMBER_WORD})${END})*)`;
const MONTH = String.raw`(?:ב|ל)[-־]?(${alt(Object.keys(MONTHS))})${END}(?:\s+(\d{4}))?`;
const CURRENCY = String.raw`(?=\s*(?:₪|ש"ח|ש״ח|שקל))`;
const PERCENT = String.raw`\s*אחוז(?:ים)?${END}`;

/** The value of a run of number words, or null when the words do not form a number. */
export function parseHebrewNumber(phrase: string): number | null {
  const words = phrase.split(/\s+/u).map((w, i) => (i > 0 && w.startsWith('ו') && !(w in UNITS) && !(w in TENS) && !BIG.includes(w) ? w.slice(1) : w));
  let total = 0;
  let cur = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w in UNITS) {
      let v = UNITS[w]!;
      const next = words[i + 1];
      if (v < 10 && (next === 'עשר' || next === 'עשרה')) {
        v += 10;
        i++;
      }
      cur += v;
    } else if (w in TENS) cur += TENS[w]!;
    else if (w === 'מאה') cur += 100;
    else if (w === 'מאתיים') cur += 200;
    else if (w === 'מאות') cur = (cur || 1) * 100;
    else if (w === 'אלף') (total += (cur || 1) * 1000), (cur = 0);
    else if (w === 'אלפיים') (total += 2000), (cur = 0);
    else if (w === 'אלפים') (total += (cur || 1) * 1000), (cur = 0);
    else return null;
  }
  const n = total + cur;
  return n > 0 ? n : null;
}

const dateOf = (day: number, monthName: string, year?: string) => (day >= 1 && day <= 31 ? `${day}/${MONTHS[monthName]}${year ? `/${year}` : ''}` : null);

const PART_OF_DAY = String.raw`(?:\s+(בבוקר|בצהריים|בצהרים|אחה"צ|אחה״צ|אחר הצהריים|בערב|בלילה))?`;

/** Rewrites the written Hebrew forms of prices, discounts, dates, times and weekdays into digit forms. */
export function normalizeHebrewDetails(text: string): string {
  let out = text;
  // Dates: a day in digits, an ordinal, or words, then a month name.
  out = out.replace(new RegExp(String.raw`${START}([בלמה]?[-־]?)(\d{1,2})\s*${MONTH}`, 'gu'), (m, p: string, d: string, mo: string, y?: string) => {
    const date = dateOf(Number(d), mo, y);
    return date ? `${p} ${date}` : m;
  });
  out = out.replace(new RegExp(String.raw`${START}((?:[בלמ]|עד\s+)?)ה[-־]?(${alt(Object.keys(ORDINALS))})\s+${MONTH}`, 'gu'), (m, p: string, o: string, mo: string, y?: string) => {
    const date = dateOf(ORDINALS[o]!, mo, y);
    return date ? `${p} ${date}` : m;
  });
  out = out.replace(new RegExp(String.raw`${PHRASE}\s+${MONTH}`, 'gu'), (m, p: string, words: string, mo: string, y?: string) => {
    const n = parseHebrewNumber(words);
    const date = n === null ? null : dateOf(n, mo, y);
    return date ? `${p} ${date}` : m;
  });
  // Times: בשעה / השעה, then an hour in digits or words, then וחצי / ורבע and a part of day.
  const hourWords = String.raw`(\d{1,2}(?![\d:])|(?:${NUMBER_WORD})${END}(?:\s+(?:עשרה|עשר)${END})?)`;
  out = out.replace(
    new RegExp(String.raw`${START}((?:ב|עד\s+|מ)?ה?שעה)\s+${hourWords}(?:\s+ו(חצי|רבע)${END})?${PART_OF_DAY}`, 'gu'),
    (m, lead: string, hour: string, frac: string | undefined, part: string | undefined) => {
      let h = /\d/u.test(hour) ? Number(hour) : parseHebrewNumber(hour);
      if (h === null || h > 24) return m;
      const min = frac === 'חצי' ? '30' : frac === 'רבע' ? '15' : '00';
      if (h < 12 && part) {
        if (part.startsWith('בצהר')) h += h <= 5 ? 12 : 0;
        else if (part === 'בלילה') h += h >= 7 ? 12 : 0;
        else if (part !== 'בבוקר') h += 12;
      }
      return `${lead} ${part ? '' : '~'}${h}:${min}`;
    },
  );
  // Prices and discounts in words.
  out = out.replace(new RegExp(String.raw`${PHRASE}${CURRENCY}`, 'gu'), (m, p: string, words: string) => {
    const n = parseHebrewNumber(words);
    return n === null ? m : `${p}${n}`;
  });
  out = out.replace(new RegExp(String.raw`${PHRASE}${PERCENT}`, 'gu'), (m, p: string, words: string) => {
    const n = parseHebrewNumber(words);
    return n === null ? m : `${p}${n}%`;
  });
  out = out.replace(new RegExp(String.raw`(\d+(?:[.,]\d+)?)${PERCENT}`, 'gu'), '$1%');
  return out;
}

/** The weekdays a text names: יום X, יום א׳, בחמישי etc., and every day in a range. */
export function weekdays(text: string): string[] {
  const found: string[] = [];
  const name = alt([...WEEKDAYS]);
  const letter = String.raw`([${DAY_LETTERS}])['׳]`;
  const day = String.raw`(?:(${name})|${letter})`;
  const idx = (n?: string, l?: string) => (n ? WEEKDAYS.indexOf(n as (typeof WEEKDAYS)[number]) : DAY_LETTERS.indexOf(l!));
  let rest = text;
  // Ranges: א׳-ה׳, ראשון עד חמישי, ימים א-ה.
  const range = new RegExp(String.raw`${START}(?:ימים\s+|ימי\s+|יום\s+|מ)?(?:(${name})|([${DAY_LETTERS}])['׳]?)\s*(?:-|–|עד)\s*(?:יום\s+)?(?:(${name})|([${DAY_LETTERS}])['׳]?)${END}`, 'gu');
  rest = rest.replace(range, (m, n1?: string, l1?: string, n2?: string, l2?: string) => {
    const a = idx(n1, l1);
    const b = idx(n2, l2);
    if (a < 0 || b < 0 || a >= b) return m;
    for (let i = a; i <= b; i++) found.push(WEEKDAYS[i]!);
    return ' ';
  });
  for (const m of rest.matchAll(new RegExp(String.raw`${START}ו?(?:ב|מ|ל)?(?:יום|ימי)\s+${day}${END}`, 'gu'))) found.push(WEEKDAYS[idx(m[1], m[2])]!);
  rest = rest.replace(new RegExp(String.raw`${START}ו?(?:ב|מ|ל)?(?:יום|ימי)\s+${day}${END}`, 'gu'), ' ');
  for (const m of rest.matchAll(new RegExp(String.raw`${START}ו?(?:ב|מ|עד\s+)(שלישי|רביעי|חמישי|שישי|שבת)${END}`, 'gu'))) found.push(m[1]!);
  return found;
}
