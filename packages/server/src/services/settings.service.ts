import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

export class SettingsService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  get(key: string): string | null {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
  }

  getAll(): Record<string, string> {
    const rows = this.db.select().from(schema.settings).all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}
