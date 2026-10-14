import { PGlite } from '@electric-sql/pglite'
import type { DatabasePool, QueryClient, QueryResult } from './store.ts'

/** Real embedded Postgres for localnet and integration tests. Never a production financial store. */
export class LocalDatabasePool implements DatabasePool {
  readonly db: PGlite
  private tail: Promise<void> = Promise.resolve()
  constructor(directory?: string) { this.db = new PGlite(directory) }
  async connect(): Promise<QueryClient & { release(): void }> {
    let release!: () => void
    const previous = this.tail
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    await this.db.waitReady
    return {
      query: async <T>(text: string, values: unknown[] = []): Promise<QueryResult<T>> => {
        const result = await this.db.query<T>(text, values)
        return { rows: result.rows, rowCount: result.affectedRows || result.rows.length }
      }, release,
    }
  }
  async migrate(sql: string) { await this.db.exec(sql) }
  async end() { await this.tail; await this.db.close() }
}
