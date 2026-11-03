import { z } from 'zod';
import { Uuid } from './common.js';

/** What the agent is waiting for, stored in `conversation_state.open_question` (contracts.md). */
export const OpenQuestion = z.object({
  /** Which question of the current step. */
  key: z.string().min(1),
  /** Profile fields the question asks for; may be empty. */
  askedFields: z.array(z.string()),
  /** How many times the question was asked. */
  attempts: z.int().min(1),
  /** Business photos the owner sent during onboarding; they are not part of the profile. */
  photoAssetIds: z.array(Uuid).default([]),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;
