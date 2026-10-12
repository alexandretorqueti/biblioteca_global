import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../../migrations/0085_realtime_event_outbox.sql',
  import.meta.url,
);

describe('migration 0085 realtime outbox', () => {
  it('pode ser retomada depois de DDL MySQL parcialmente aplicado', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `realtime_event_outbox`/);
    expect(sql.trimEnd()).not.toMatch(/--> statement-breakpoint$/);
  });
});
