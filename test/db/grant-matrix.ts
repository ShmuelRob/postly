import type { BusinessRole, SystemPurpose } from '../../src/db/index.js';

// The grant matrix from database-schema.md, "Least privilege", copied without the backticks: a doc change and
// this table change together. S select, I insert, U update, D delete, U(col, ...) update of those columns only.
const MATRIX = `
| Table | messaging | workflow | content | design | approval | publishing | model | billing | business_data | deletion | phone_lookup | scheduler | console | example_set |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| business | S | SIU | S | S | S | S |  | S | SU | SD | S | S | SU |  |
| channel_connection |  | S |  |  |  | SIU |  |  | S |  |  | S | SU |  |
| conversation_state | SU | SIU |  |  |  |  |  |  |  |  |  |  | SIU |  |
| message | SIU | S | S |  | S |  |  |  |  |  | SI |  | S |  |
| media_asset | SI |  | S | SI |  | S |  |  | SIUD | S |  |  | S |  |
| preference_rule |  |  | S |  |  |  |  |  | SIUD |  |  |  | S |  |
| weekly_update |  | SIU | SU |  |  |  |  |  |  |  |  | S | S |  |
| post |  | SIU | SU | S | S U(status, updated_at) | SU |  |  | S |  |  | S | SU |  |
| post_version |  |  | SI | S | S | S |  |  | S |  |  |  | S |  |
| approval |  |  |  |  | SI U(invalidated_at) | S |  |  |  |  |  |  | S |  |
| publication |  |  |  |  |  | SIU |  |  | S |  |  | S | SIU |  |
| subscription |  |  |  |  |  |  |  | SIU |  |  |  | S | S |  |
| model_run |  |  |  |  |  |  | SI |  |  |  |  |  | S | SI |
| console_item |  | SI |  |  |  | SI | SI |  |  |  | SI |  | SIU |  |
| workflow_event |  | I |  |  | I | I |  | I |  |  |  |  | S |  |
| model_task_config |  |  |  |  |  |  | S |  |  |  |  |  | SU | S |
| prompt_template |  |  |  |  |  |  | S |  |  |  |  |  | SI | S |
| system_control |  |  |  |  |  | S |  |  |  |  |  | S | SIU |  |
| plan_price |  |  |  |  |  |  |  | S |  |  |  |  | SI |  |
`;

export type Role = BusinessRole | SystemPurpose;
export type Verb = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface Grant {
  verbs: Set<Verb>;
  /** Columns the role may update when it has no table-wide UPDATE. */
  updateColumns: string[];
}

const VERBS: Record<string, Verb> = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' };
const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
const [header, , ...rows] = MATRIX.trim().split('\n');

export const MATRIX_ROLES = cells(header!).slice(1) as Role[];

/** grants.get(table).get(role); every table and role in the matrix is present. */
export const grants = new Map<string, Map<Role, Grant>>(
  rows.map((line) => {
    const [table, ...byRole] = cells(line);
    const perRole = new Map<Role, Grant>();
    MATRIX_ROLES.forEach((role, i) => {
      const cell = byRole[i] ?? '';
      const updateColumns = [...cell.matchAll(/U\(([a-z_, ]+)\)/g)].flatMap((m) => m[1]!.split(',').map((c) => c.trim()));
      const letters = cell.replace(/U\([a-z_, ]+\)/g, '').replace(/\s/g, '');
      perRole.set(role, { verbs: new Set([...letters].map((l) => VERBS[l]!)), updateColumns });
    });
    return [table!, perRole];
  }),
);

export const has = (table: string, role: Role, verb: Verb) => grants.get(table)!.get(role)!.verbs.has(verb);

/** The first business role in the matrix with verb on table (or a column update, for UPDATE). */
export function roleWith(table: string, verb: Verb, roles: readonly Role[]): Role | undefined {
  return roles.find((r) => has(table, r, verb) || (verb === 'UPDATE' && grants.get(table)!.get(r)!.updateColumns.length > 0));
}
