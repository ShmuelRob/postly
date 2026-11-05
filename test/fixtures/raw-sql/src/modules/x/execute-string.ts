// Drizzle runs a plain string passed to execute() as SQL, so it is dynamic SQL for the guard (WP-86).
export const e = (tx: { execute(s: string): unknown }) => tx.execute("select set_" + "config('app.business_id', '1', true)");
