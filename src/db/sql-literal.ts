/** A Postgres string literal; ALTER ROLE ... PASSWORD takes no bind parameters. */
export function quoteLiteral(value: string): string {
  const body = value.replaceAll("'", "''");
  return value.includes('\\') ? `E'${body.replaceAll('\\', '\\\\')}'` : `'${body}'`;
}
