import { NETWORKS } from '../contracts/common.js';
import { type ModelTaskInput, type ModelTaskName, type ModelTaskOutput, modelTasks } from '../contracts/model-tasks.js';

// Default outputs per model task. Each is built from the input when the input
// parses, so the code checks downstream pass (verbatim quotes, post counts,
// allowed formats, requested networks); otherwise a fixed valid output is used.
// Hebrew content, as the product's default language.

type DefaultFixture<T extends ModelTaskName> = (input: ModelTaskInput<T> | undefined) => ModelTaskOutput<T>;

const plannedTypes = ['products', 'tips'] as const;

export const defaultFixtures: { [T in ModelTaskName]: DefaultFixture<T> } = {
  intent_detection: () => ({ intent: 'other', confidence: 0.5 }),

  transcription: (input) => ({ text: 'הודעה קולית לדוגמה', language: input?.languageHint ?? 'he' }),

  profile_extraction: (input) => ({ found: {}, unclear: input?.askedFields ?? [] }),

  fact_extraction: (input) => {
    const source = input?.text.trim() || input?.transcript?.trim();
    return {
      facts: source ? [{ id: 'f1', type: 'other', value: source, sourceQuote: source }] : [],
      missingDetails: [],
    };
  },

  weekly_planning: (input) => {
    const count = input?.postsPerWeek ?? 2;
    const contentTypes = input?.contentTypes ?? plannedTypes;
    const format = input?.formats[0] ?? 'single';
    const factIds = input?.facts.map((f) => f.id) ?? [];
    const mediaAssetIds = input?.mediaAssetIds ?? [];
    return {
      posts: Array.from({ length: count }, (_, i) => ({
        topic: `פוסט ${i + 1}`,
        contentType: contentTypes[i % contentTypes.length] ?? 'products',
        format,
        factIds: i === 0 ? factIds : [],
        mediaAssetIds: mediaAssetIds.length > 0 ? [mediaAssetIds[i % mediaAssetIds.length] as string] : [],
        brief: `פוסט ${i + 1} מתוך ${count} השבוע`,
      })),
    };
  },

  caption_writing: (input) => {
    const caption = { text: input?.plan.brief ?? 'פוסט לדוגמה', hashtags: input?.fixedHashtags ?? [] };
    const networks = input?.networks ?? NETWORKS;
    return {
      captions: Object.fromEntries(networks.map((n) => [n, caption])),
      usedFactIds: input?.plan.factIds ?? [],
    };
  },

  change_interpretation: (input) => ({
    changes: [{ target: 'caption', instruction: input?.text ?? 'לשנות את הכיתוב' }],
  }),

  image_review: () => ({ usable: true, score: 0.9, issues: [] }),

  fact_check: () => ({ mismatches: [] }),
};

export function defaultOutput<T extends ModelTaskName>(task: T, input: unknown): ModelTaskOutput<T> {
  const parsed = modelTasks[task].input.safeParse(input);
  const fixture = defaultFixtures[task] as DefaultFixture<T>;
  return modelTasks[task].output.parse(fixture(parsed.success ? (parsed.data as ModelTaskInput<T>) : undefined)) as ModelTaskOutput<T>;
}
