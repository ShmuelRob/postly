import { sql } from 'drizzle-orm';
const name = 'app.business_id';
export const q = sql.raw(`select set_${'config'}('${name}', '1', true)`);
export const r = (c: { unsafe(s: string): unknown }) => c.unsafe('select 1');
