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
