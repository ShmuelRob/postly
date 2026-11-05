import { describe, expect, it } from 'vitest';
import { createDatabase, databaseUrls } from './index.js';

// D9 (WP-84): a process gets URLs only for the logins it uses; using any other role fails loudly
// instead of falling back to PG* environment variables or another login.

describe('a database with only some logins', () => {
  const urls = databaseUrls('postgres://db.internal:5432/postly', (l) => `pw-${l}`, ['app_sys_console', 'app_workflow']);

  it('builds URLs only for the listed logins', () => {
    expect(urls.system.console).toContain('app_sys_console:pw-app_sys_console@');
    expect(urls.business.workflow).toContain('app_workflow:');
    expect(urls.business.model).toBeUndefined();
  });

  it('refuses a role whose login is not configured, before connecting', async () => {
    const db = createDatabase(urls);
    await expect(db.withBusiness('model', '00000000-0000-4000-8000-000000000001', async () => 1)).rejects.toThrow('app_model is not configured');
    await expect(db.withSystem('scheduler', async () => 1)).rejects.toThrow('app_sys_scheduler is not configured');
    await db.close();
  });

  it('still refuses a URL that logs in as the wrong role', () => {
    expect(() => createDatabase({ business: { workflow: 'postgres://app_model:x@db/postly' }, system: {} })).toThrow('must log in as app_workflow');
  });
});
