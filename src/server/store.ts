import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { State } from '../domain/types';
import { PolicyError } from '../domain/policy';
import { createFixtures } from './fixtures';
export interface Session {
  id: string;
  csrf: string;
  expiresAt: number;
}
export interface Store {
  create(): Session;
  session(id: string): Session | null;
  read(id: string): State;
  transact<T>(id: string, work: (state: State) => T): T;
}
/** Synchronous BEGIN IMMEDIATE serializes approval + ledger changes; never holds a network call. */
export class SQLiteStore implements Store {
  private db: DatabaseSync;
  private seed: () => State;
  constructor(path = '.data/marginguard.sqlite', options: { seed?: () => State } = {}) {
    this.seed = options.seed ?? createFixtures;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(new URL('../../migrations/001_local.sql', import.meta.url), 'utf8'));
  }
  close() {
    this.db.close();
  }
  create(): Session {
    const session = {
      id: crypto.randomUUID(),
      csrf: crypto.randomUUID(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    this.db
      .prepare('INSERT INTO demo_sessions VALUES (?, ?, ?, ?, ?)')
      .run(session.id, session.csrf, Date.now(), session.expiresAt, JSON.stringify(this.seed()));
    return session;
  }
  session(id: string): Session | null {
    const row = this.db
      .prepare('SELECT id, csrf, expires_at FROM demo_sessions WHERE id = ? AND expires_at > ?')
      .get(id, Date.now()) as { id: string; csrf: string; expires_at: number } | undefined;
    return row ? { id: row.id, csrf: row.csrf, expiresAt: row.expires_at } : null;
  }
  read(id: string): State {
    const row = this.db
      .prepare('SELECT state_json FROM demo_sessions WHERE id = ? AND expires_at > ?')
      .get(id, Date.now()) as { state_json: string } | undefined;
    if (!row)
      throw new PolicyError('Session expired. Reload to create a new local workspace.', 401);
    return JSON.parse(row.state_json) as State;
  }
  transact<T>(id: string, work: (state: State) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read(id);
      const oldIds = new Set(state.audit.map((event) => event.id));
      const result = work(state);
      this.db
        .prepare('UPDATE demo_sessions SET state_json = ? WHERE id = ?')
        .run(JSON.stringify(state), id);
      for (const event of state.audit.filter((event) => !oldIds.has(event.id)))
        this.db
          .prepare('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?)')
          .run(event.id, id, event.at, event.type, event.orderId, event.detail);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
