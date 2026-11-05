// Fixed owner-facing lines of the agent runtime. PROVISIONAL copy (H6), in the persona's voice:
// feminine Hebrew (agent.md, A2).

/** Sent when the agent hands the conversation to a person, by its own call or at a limit. */
export const handOffLine = (personaName: string) =>
  `כאן ${personaName}. אני מעבירה את השיחה לצוות שלנו, ומישהו יחזור אליך בקרוב.`;
