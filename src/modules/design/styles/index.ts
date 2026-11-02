import type { z } from 'zod';
import type { VisualStyle } from '../../../contracts/common.js';
import { clean } from './clean.js';
import { dynamic } from './dynamic.js';
import type { StyleTemplate } from './types.js';
import { warm } from './warm.js';

export type StyleRegistry = Record<z.infer<typeof VisualStyle>, StyleTemplate>;

export const styles: StyleRegistry = { clean, warm, dynamic };
