// Shabbat and Israeli yom tov times, computed in our own code (technical-design.md, Configuration
// defaults). No third-party calendar library: sunset and nightfall come from the NOAA solar
// equations, the yom tov dates from the fixed rules of the Hebrew calendar.
//
// Candle lighting is sunset minus the city's custom (40 minutes in Jerusalem, 30 in Haifa and
// Zikhron Ya'akov, 20 elsewhere in Israel); havdalah is nightfall, the sun 8.5 degrees below the horizon.

export interface City {
  name: string;
  /** Other spellings, Hebrew first, matched without case, spaces, quotes or hyphens. */
  aliases: string[];
  latitude: number;
  longitude: number;
  candleLightingMinutes: number;
}

const city = (name: string, aliases: string[], latitude: number, longitude: number, candleLightingMinutes = 20): City => ({ name, aliases, latitude, longitude, candleLightingMinutes });

export const JERUSALEM = city('Jerusalem', ['ירושלים', 'Yerushalayim'], 31.76904, 35.21633, 40);

export const CITIES: readonly City[] = [
  JERUSALEM,
  city('Tel Aviv', ['תל אביב', 'תל אביב יפו', 'תל־אביב', 'Tel Aviv-Yafo', 'Tel Aviv Yafo', 'Jaffa', 'יפו'], 32.08088, 34.78057),
  city('Haifa', ['חיפה'], 32.81841, 34.9885, 30),
  city("Zikhron Ya'akov", ['זכרון יעקב', "Zikhron Ya'aqov", 'Zichron Yaakov', "Zichron Ya'akov", 'Zikhron Yaakov'], 32.57076, 34.95152, 30),
  city('Beer Sheva', ['באר שבע', "Be'er Sheva", 'Beersheba', 'Beer Sheba'], 31.25181, 34.7913),
  city('Ashdod', ['אשדוד'], 31.79213, 34.64966),
  city('Ashkelon', ['אשקלון'], 31.66926, 34.57149),
  city('Netanya', ['נתניה'], 32.33291, 34.85992),
  city('Petah Tikva', ['פתח תקווה', 'פתח תקוה', 'Petach Tikvah', 'Petach Tikva', 'Petah Tiqwa'], 32.08707, 34.88747),
  city('Rishon LeZion', ['ראשון לציון', 'Rishon Lezion', 'Rishon Le Zion'], 31.97102, 34.78939),
  city('Holon', ['חולון'], 32.01034, 34.77918),
  city('Bat Yam', ['בת ים'], 32.02379, 34.75185),
  city('Ramat Gan', ['רמת גן'], 32.08227, 34.81065),
  city('Bnei Brak', ['בני ברק'], 32.08074, 34.8338),
  city('Herzliya', ['הרצליה'], 32.16627, 34.82536),
  city("Ra'anana", ['רעננה', 'Raanana'], 32.1836, 34.87386),
  city('Kfar Saba', ['כפר סבא'], 32.175, 34.90694),
  city('Hod HaSharon', ['הוד השרון', 'Hod Hasharon'], 32.15934, 34.89320),
  city('Rehovot', ['רחובות'], 31.89421, 34.81199),
  city('Modiin', ['מודיעין', 'מודיעין מכבים רעות', "Modi'in", "Modi'in-Maccabim-Re'ut"], 31.89385, 35.01504),
  city('Beit Shemesh', ['בית שמש'], 31.73072, 34.99293),
  city('Lod', ['לוד'], 31.9467, 34.8903),
  city('Ramla', ['רמלה'], 31.92923, 34.86563),
  city('Hadera', ['חדרה'], 32.44192, 34.9039),
  city('Nazareth', ['נצרת'], 32.70056, 35.29722),
  city('Afula', ['עפולה'], 32.60907, 35.2892),
  city('Tiberias', ['טבריה'], 32.79221, 35.53124),
  city('Safed', ['צפת', 'Tzfat', 'Zefat'], 32.96465, 35.496),
  city('Karmiel', ['כרמיאל'], 32.91708, 35.30501),
  city('Nahariya', ['נהריה'], 33.00892, 35.09814),
  city('Akko', ['עכו', 'Acre'], 32.92814, 35.07647),
  city('Kiryat Shmona', ['קריית שמונה', 'קרית שמונה'], 33.20733, 35.57212),
  city('Eilat', ['אילת'], 29.55805, 34.94821),
  city('Dimona', ['דימונה'], 31.07079, 35.03269),
  city('Arad', ['ערד'], 31.25882, 35.21282),
  city('Ariel', ['אריאל'], 32.10609, 35.18734),
  city("Ma'ale Adumim", ['מעלה אדומים', 'Maale Adumim'], 31.77757, 35.29858),
];

const normalize = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s'"׳״`’\-־]/g, '');
const byName = new Map(CITIES.flatMap((c) => [c.name, ...c.aliases].map((n) => [normalize(n), c] as const)));

/** The city by its English or Hebrew name, or Jerusalem when we do not know it. */
export function lookupCity(name: string | undefined): City {
  return (name && byName.get(normalize(name))) || JERUSALEM;
}

// --- Sun (NOAA solar calculator equations) ---------------------------------------------------

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function sun(t: number) {
  const l0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(rad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * t) + Math.sin(rad(3 * m)) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const declination = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime =
    4 * deg(y * Math.sin(2 * rad(l0)) - 2 * e * Math.sin(rad(m)) + 4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0)) - 0.5 * y * y * Math.sin(4 * rad(l0)) - 1.25 * e * e * Math.sin(2 * rad(m)));
  return { declination, eqTime };
}

/**
 * The evening time on the UTC calendar date `day` (UTC midnight) when the sun's centre reaches
 * `zenith` degrees: 90.833 is sunset, 98.5 is nightfall (8.5 degrees below the horizon).
 */
export function sunDown(day: Date, latitude: number, longitude: number, zenith: number): Date {
  const jd0 = day.getTime() / 86_400_000 + 2440587.5;
  let minutes = 720 - 4 * longitude;
  for (let i = 0; i < 3; i++) {
    const { declination, eqTime } = sun((jd0 + minutes / 1440 - 2451545) / 36525);
    const cosH = Math.cos(rad(zenith)) / (Math.cos(rad(latitude)) * Math.cos(rad(declination))) - Math.tan(rad(latitude)) * Math.tan(rad(declination));
    minutes = 720 - 4 * (longitude - deg(Math.acos(cosH))) - eqTime;
  }
  return new Date(day.getTime() + Math.round(minutes * 60) * 1000);
}

const floorMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);
const roundMinute = (d: Date) => new Date(Math.round(d.getTime() / 60_000) * 60_000);

/** Candle lighting on the evening of `day` (UTC midnight of a local date), to the minute. */
export function candleLighting(day: Date, c: City): Date {
  return floorMinute(new Date(sunDown(day, c.latitude, c.longitude, 90.833).getTime() - c.candleLightingMinutes * 60_000));
}

/** Havdalah (nightfall, 8.5 degrees) on the evening of `day`, to the minute. */
export function havdalah(day: Date, c: City): Date {
  return roundMinute(sunDown(day, c.latitude, c.longitude, 98.5));
}

// --- Hebrew calendar --------------------------------------------------------------------------

const isLeap = (year: number) => (7 * year + 1) % 19 < 7;

/** Days from the Hebrew epoch to 1 Tishrei of `year`, with the postponement rules. */
function elapsedDays(year: number): number {
  const y = year - 1;
  const months = 235 * Math.floor(y / 19) + 12 * (y % 19) + Math.floor((7 * (y % 19) + 1) / 19);
  const partsElapsed = 204 + 793 * (months % 1080);
  const hours = 5 + 12 * months + 793 * Math.floor(months / 1080) + Math.floor(partsElapsed / 1080);
  let day = 1 + 29 * months + Math.floor(hours / 24);
  const parts = 1080 * (hours % 24) + (partsElapsed % 1080);
  if (parts >= 19440 || (day % 7 === 2 && parts >= 9924 && !isLeap(year)) || (day % 7 === 1 && parts >= 16789 && isLeap(year - 1))) day++;
  if (day % 7 === 0 || day % 7 === 3 || day % 7 === 5) day++;
  return day;
}

// 1 Tishrei 5787 is Saturday 2026-09-12.
const EPOCH_MS = Date.UTC(2026, 8, 12) - elapsedDays(5787) * 86_400_000;

/** Rosh Hashana (1 Tishrei) of Hebrew `year`, as UTC midnight of that date. */
export function roshHashana(year: number): Date {
  return new Date(EPOCH_MS + elapsedDays(year) * 86_400_000);
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * The Israeli yom tov days (rest days) of Hebrew `year`: Rosh Hashana (two days), Yom Kippur, the
 * first day of Sukkot, Shemini Atzeret, the first and seventh days of Pesach, and Shavuot.
 */
export function yomTovDays(year: number): { name: string; date: Date }[] {
  const rh = roshHashana(year);
  // The first day of Pesach is always 163 days before the next Rosh Hashana.
  const pesach = addDays(roshHashana(year + 1), -163);
  return [
    { name: 'Rosh Hashana I', date: rh },
    { name: 'Rosh Hashana II', date: addDays(rh, 1) },
    { name: 'Yom Kippur', date: addDays(rh, 9) },
    { name: 'Sukkot I', date: addDays(rh, 14) },
    { name: 'Shmini Atzeret', date: addDays(rh, 21) },
    { name: 'Pesach I', date: pesach },
    { name: 'Pesach VII', date: addDays(pesach, 6) },
    { name: 'Shavuot', date: addDays(pesach, 50) },
  ];
}

/**
 * Every rest period overlapping the local dates from `first` to `last` (UTC midnights): from
 * candle lighting on the eve of the first rest day to havdalah on the last, with Shabbat and yom
 * tov days next to each other merged into one period.
 */
export function restPeriods(first: Date, last: Date, c: City): { candleLighting: Date; havdalah: Date }[] {
  const from = addDays(first, -2);
  const to = addDays(last, 2);
  const rest = new Set<number>();
  // Hebrew year of a date: the civil year plus 3760 or 3761.
  const startYear = from.getUTCFullYear() + 3759;
  for (let y = startYear; y <= to.getUTCFullYear() + 3761; y++) for (const d of yomTovDays(y)) rest.add(d.date.getTime());
  const periods: { candleLighting: Date; havdalah: Date }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const isRest = (x: Date) => x.getUTCDay() === 6 || rest.has(x.getTime());
    if (!isRest(d) || isRest(addDays(d, -1))) continue;
    let end = d;
    while (isRest(addDays(end, 1))) end = addDays(end, 1);
    periods.push({ candleLighting: candleLighting(addDays(d, -1), c), havdalah: havdalah(end, c) });
  }
  return periods;
}
