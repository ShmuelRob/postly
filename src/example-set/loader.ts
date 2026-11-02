import { access, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { BusinessProfile } from '../contracts/business-profile.js';
import type { PlaceholderSpec } from './placeholder-photo.js';
import { ExampleEntryFile } from './schema.js';

export const EXAMPLE_SET_DIR = fileURLToPath(new URL('../../fixtures/example-set/', import.meta.url));

const ENTRY_FILE = 'entry.json';
const UPDATE_FILE = 'weekly-update.txt';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ExamplePhoto {
  /** Absolute path to the photo file. */
  path: string;
  description: string;
  placeholder?: PlaceholderSpec;
}

export interface ExampleEntry {
  /** The entry folder name. */
  id: string;
  provisional: boolean;
  profile: BusinessProfile;
  /** The owner's weekly update, trimmed. */
  weeklyUpdate: string;
  photos: ExamplePhoto[];
  expected: ExampleEntryFile['expected'];
}

export class ExampleSetError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid example set:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ExampleSetError';
  }
}

const issuesOf = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Loads one entry folder and validates it, throwing an ExampleSetError that lists every problem. */
export async function loadExampleEntry(dir: string): Promise<ExampleEntry> {
  const id = basename(dir);
  const fail = (problems: string[]) => new ExampleSetError(problems.map((p) => `${id}: ${p}`));

  if (!SLUG.test(id)) throw fail(['folder name must be a kebab-case slug']);

  const raw = await readText(join(dir, ENTRY_FILE));
  if (raw === undefined) throw fail([`${ENTRY_FILE} is missing`]);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw fail([`${ENTRY_FILE} is not valid JSON: ${(error as Error).message}`]);
  }

  const problems: string[] = [];
  const parsed = ExampleEntryFile.safeParse(json);
  if (!parsed.success) problems.push(...issuesOf(parsed.error));

  const weeklyUpdate = (await readText(join(dir, UPDATE_FILE)))?.trim() ?? '';
  if (weeklyUpdate === '') problems.push(`${UPDATE_FILE} is missing or empty`);

  if (!parsed.success) throw fail(problems);
  const file = parsed.data;

  file.expected.facts.forEach((fact, i) => {
    if (weeklyUpdate !== '' && !weeklyUpdate.includes(fact.sourceQuote)) {
      problems.push(`expected.facts.${i}.sourceQuote: "${fact.sourceQuote}" is not verbatim in ${UPDATE_FILE}`);
    }
  });

  const photos: ExamplePhoto[] = [];
  for (const photo of file.photos) {
    const path = join(dir, ...photo.file.split('/'));
    if (!(await exists(path))) problems.push(`${photo.file} is missing`);
    photos.push({
      path,
      description: photo.description,
      ...(photo.placeholder ? { placeholder: photo.placeholder } : {}),
    });
  }

  if (problems.length > 0) throw fail(problems);
  return { id, provisional: file.provisional, profile: file.profile, weeklyUpdate, photos, expected: file.expected };
}

/** Loads every entry folder under dir, in name order, reporting all broken entries together. */
export async function loadExampleSet(dir: string = EXAMPLE_SET_DIR): Promise<ExampleEntry[]> {
  const folders = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const entries: ExampleEntry[] = [];
  const problems: string[] = [];
  for (const name of folders) {
    try {
      entries.push(await loadExampleEntry(join(dir, name)));
    } catch (error) {
      if (!(error instanceof ExampleSetError)) throw error;
      problems.push(...error.problems);
    }
  }
  if (problems.length > 0) throw new ExampleSetError(problems);
  return entries;
}
