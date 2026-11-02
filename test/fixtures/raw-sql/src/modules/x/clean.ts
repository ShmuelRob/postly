// Resets the form and sets the role badge; discards nothing in SQL.
export const label = 'reset password';
export const q = sql`select 1 from post where status = 'set'`;
