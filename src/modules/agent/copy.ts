import type { z } from 'zod';
import type { Language } from '../../contracts/common.js';

// Fixed owner-facing lines of the agent runtime. PROVISIONAL copy (H6), in the persona's voice:
// feminine where the language marks gender (agent.md, A2), in the business's first language.

type Lang = z.infer<typeof Language>;

const HAND_OFF: Record<Lang, (name: string) => string> = {
  he: (name) => `כאן ${name}. אני מעבירה את השיחה לצוות שלנו, ומישהו יחזור אליך בקרוב.`,
  ar: (name) => `معك ${name}. سأحوّل المحادثة إلى فريقنا، وسيتواصل معك أحدهم قريبًا.`,
  en: (name) => `This is ${name}. I'm passing this conversation to our team, and someone will get back to you soon.`,
  ru: (name) => `Это ${name}. Я передала разговор нашей команде, с вами скоро свяжутся.`,
};

/** Sent when the agent hands the conversation to a person, by its own call or at a limit. */
export const handOffLine = (personaName: string, language: Lang) => HAND_OFF[language](personaName);

/**
 * The two batches of profile questions (agent.md, A11: batched onboarding). PROVISIONAL copy (H6),
 * Hebrew like the rest of the onboarding copy, the owner addressed in the plural (the profile
 * default). Code sends batch A after the intro, and appends batch B to the agent's first question
 * after batch A's answer. They live here because the agent's tool appends batch B and the agent
 * module never imports workflow (agent.md, Module direction).
 */
export const onboardingBatches = {
  a:
    'נתחיל בהיכרות. אפשר לענות בהודעה אחת או בכמה:\n' +
    '1. איך קוראים לעסק, מה התחום ומה המוצרים או השירותים העיקריים?\n' +
    '2. איפה העסק נמצא? עיר וכתובת.\n' +
    '3. מה שעות הפתיחה?\n' +
    '4. יש איסוף עצמי, משלוחים או שניהם?',
  b:
    'ועוד כמה שאלות:\n' +
    '1. מי הלקוחות שלכם?\n' +
    '2. מה מייחד את העסק, למה בוחרים דווקא בכם?\n' +
    '3. באילו רשתות לפרסם: אינסטגרם, פייסבוק או שתיהן?\n' +
    '4. לפרסם גם בשבת ובחגים?\n' +
    '5. יש עוד משהו שחשוב שהלקוחות ידעו?',
  /** The open question code stores with batch A. */
  aKey: 'batch:a',
  aFields: ['name', 'field', 'mainProducts', 'location'],
  /** The open question key of the agent's question that batch B was appended to. */
  bKey: 'batch:b',
  bFields: ['targetAudience', 'differentiator', 'channels', 'schedule'],
} as const;
