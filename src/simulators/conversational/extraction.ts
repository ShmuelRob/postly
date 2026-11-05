import type { BusinessProfileDraft } from '../../contracts/business-profile.js';
import type { Network } from '../../contracts/common.js';

/**
 * A stand-in for the model's profile_extraction on the model simulator, so the human can answer the
 * onboarding questions in free Hebrew. Not product logic: it fills each asked field from the whole
 * answer with simple rules, enough to move through onboarding. The real extraction is the model's.
 */
export function playgroundExtraction(input: { text: string; askedFields: string[] }): {
  found: BusinessProfileDraft;
  unclear: string[];
} {
  const text = input.text.trim();
  if (!text) return { found: {}, unclear: input.askedFields };
  const parts = text.split(/[,.\n]| ו(?=\S)/u).map((p) => p.trim()).filter(Boolean);
  const found: BusinessProfileDraft = {};
  for (const field of input.askedFields) {
    switch (field) {
      case 'name':
        found.name = parts[0]!;
        break;
      case 'field':
        found.field = parts[1] ?? parts[0]!;
        break;
      case 'mainProducts':
        found.mainProducts = parts.length > 2 ? parts.slice(2) : [text];
        break;
      case 'location':
        found.location = {
          city: text.match(/ב([א-ת]+)(?:\s|$|[,.])/u)?.[1] ?? parts[0]!,
          address: parts[0]!,
          hours: parts.find((p) => /\d/.test(p) && p !== parts[0]) ?? text,
          fulfillment: /משלוח/u.test(text) ? (/איסוף/u.test(text) ? ['pickup', 'delivery'] : ['delivery']) : ['pickup'],
        };
        break;
      case 'targetAudience':
        found.targetAudience = text;
        break;
      case 'differentiator':
        found.differentiator = text;
        break;
      case 'channels': {
        const channels: Network[] = [];
        if (/אינסטגרם|instagram/iu.test(text)) channels.push('instagram');
        if (/פייסבוק|facebook/iu.test(text)) channels.push('facebook');
        found.channels = channels.length ? channels : ['instagram', 'facebook'];
        break;
      }
      case 'schedule':
        found.schedule = { publishOnShabbatAndHolidays: /גם בשבת|בשבת כן/u.test(text), days: [], hours: [] };
        break;
    }
  }
  return { found, unclear: [] };
}
