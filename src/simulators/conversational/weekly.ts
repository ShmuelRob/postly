/**
 * A stand-in for the model's weekly_planning on the model simulator, so a weekly update typed in the
 * playground becomes drafts that pass the code fact check (WP-34). Not product logic: the simulator's
 * default plan numbers its posts ("פוסט 1"), and a number with no source fails the fact check. These
 * topics and briefs have no numbers, and the first post carries the owner's facts.
 */
const TOPICS = ['מה חדש השבוע', 'מבצע השבוע', 'מאחורי הקלעים', 'טיפ מהעסק', 'תודה ללקוחות'];

type PlanningInput = {
  postsPerWeek: number;
  contentTypes: string[];
  formats: string[];
  facts: { id: string; value: string }[];
  mediaAssetIds: string[];
};

export function playgroundPlanning(input: PlanningInput) {
  const facts = input.facts;
  return {
    posts: Array.from({ length: input.postsPerWeek }, (_, i) => ({
      topic: TOPICS[i % TOPICS.length]!,
      contentType: input.contentTypes[i % input.contentTypes.length] ?? 'products',
      format: input.formats[0] ?? 'single',
      factIds: i === 0 ? facts.map((f) => f.id) : [],
      mediaAssetIds: input.mediaAssetIds.length > 0 ? [input.mediaAssetIds[i % input.mediaAssetIds.length]!] : [],
      brief: i === 0 && facts[0] ? facts[0].value : `${TOPICS[i % TOPICS.length]} אצלנו, מחכים לכם`,
    })),
  };
}
