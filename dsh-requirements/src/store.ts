/** SQLite ownership, durable JSON validation, and optimistic edits. @module */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PRIORITIES, STATUSES } from './types.ts'
import { isNativeThreadId, nativeKind } from './native-session.ts'
import type { NativeThreadId, Dispatch, DispatchId, Requirement, RequirementContent, RequirementFilter, RequirementId } from './types.ts'

const APPLICATION_ID = 0x5251454d
const SCHEMA_VERSION = 1
const storedSchema = Schema.object({
  id: Schema.string().required(),
  revision: Schema.number().min(1).step(1).required(),
  project: Schema.string().required(),
  title: Schema.string().required(),
  description: Schema.string().required(),
  priority: Schema.union(PRIORITIES).required(),
  status: Schema.union(STATUSES).required(),
  acceptanceCriteria: Schema.array(Schema.string()).required(),
  createdAt: Schema.string().required(),
  updatedAt: Schema.string().required(),
})
const dispatchSchema = Schema.object({
  id: Schema.string().required(),
  requirementId: Schema.string().required(),
  requirementRevision: Schema.number().min(1).step(1).required(),
  target: Schema.string().required(),
  provider: Schema.string().required(),
  state: Schema.union(['running', 'completed', 'failed', 'cancelled'] as const).required(),
  output: Schema.string().required(),
  createdAt: Schema.string().required(),
  finishedAt: Schema.union([Schema.string(), Schema.const(null)]).default(null),
  resumedFrom: Schema.string(),
})

/** Synchronous operations share one connection; each write is one SQL statement. */
export class RequirementStore {
  private readonly db: DatabaseSync

  /**
   * Open a new or current database; reject foreign and unsupported formats.
   * @param path - absolute SQLite filename.
   * @param busyTimeoutMs - maximum SQLite lock wait.
   */
  constructor(path: string, busyTimeoutMs: number) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
      this.db.exec('BEGIN IMMEDIATE')
      const app = this.db.prepare('PRAGMA application_id').get()?.application_id
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
      if (app === 0 && version === 0 && tables.length === 0) {
        this.db.exec(`CREATE TABLE requirements (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          record TEXT NOT NULL CHECK (json_valid(record))
        ) STRICT;
        CREATE TABLE dispatches (
          id TEXT PRIMARY KEY,
          requirement_id TEXT NOT NULL,
          state TEXT NOT NULL,
          record TEXT NOT NULL CHECK (json_valid(record))
        ) STRICT;
        CREATE UNIQUE INDEX one_active_dispatch ON dispatches(requirement_id) WHERE state = 'running';
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};`)
      } else if (app !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        throw new Error('dsh-requirements: foreign database or unsupported schema; choose a new databasePath')
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /**
   * Persist a new requirement in draft status.
   * @param content - complete content after defaults are resolved by the caller.
   * @returns the committed record.
   */
  create(content: RequirementContent): Requirement {
    const now = new Date().toISOString()
    const record: Requirement = { ...content, id: brandString<RequirementId>(`req_${randomUUID()}`), revision: 1, createdAt: now, updatedAt: now }
    this.db.prepare('INSERT INTO requirements VALUES (?, ?, ?)').run(record.id, record.revision, JSON.stringify(record))
    return record
  }

  /**
   * Read one requirement and validate its durable fields.
   * @param id - exact requirement id.
   * @returns the record; throws when absent or corrupt.
   */
  get(id: RequirementId): Requirement {
    const row = this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id)
    if (row === undefined) throw new Error(`dsh-requirements: unknown requirement ${id}`)
    return this.decode(row)
  }

  /**
   * Browse by exact filters; query uses literal substring matching in text fields.
   * @param filter - resolved pagination and optional filters.
   * @returns matching records ordered by priority then creation time and id.
   */
  list(filter: RequirementFilter & { limit: number; offset: number }): Requirement[] {
    const query = filter.query ?? ''
    return this.db.prepare(`SELECT * FROM requirements
      WHERE (? IS NULL OR json_extract(record, '$.project') = ?)
        AND (? IS NULL OR json_extract(record, '$.status') = ?)
        AND (? IS NULL OR json_extract(record, '$.priority') = ?)
        AND instr(lower(json_extract(record, '$.title') || char(10) ||
          json_extract(record, '$.description') || char(10) ||
          json_extract(record, '$.acceptanceCriteria')), lower(?)) > 0
      ORDER BY json_extract(record, '$.priority'), json_extract(record, '$.createdAt'), id
      LIMIT ? OFFSET ?`).all(
      filter.project ?? null, filter.project ?? null,
      filter.status ?? null, filter.status ?? null,
      filter.priority ?? null, filter.priority ?? null,
      query, filter.limit, filter.offset,
    ).map(row => this.decode(row))
  }

  /**
   * Replace editable fields only if the caller read the current revision.
   * @param id - exact requirement id.
   * @param revision - expected revision from get or list.
   * @param patch - fields to replace, including a whole acceptance list.
   * @returns the committed record; throws for stale revisions or missing ids.
   */
  update(id: RequirementId, revision: number, patch: Partial<RequirementContent>): Requirement {
    const current = this.get(id)
    const record: Requirement = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() }
    if ((record.status === 'ready' || record.status === 'in_progress' || record.status === 'done') && record.acceptanceCriteria.length === 0) {
      throw new Error('dsh-requirements: acceptance criteria are required for ready, in_progress, or done')
    }
    const result = this.db.prepare('UPDATE requirements SET revision = ?, record = ? WHERE id = ? AND revision = ?')
      .run(record.revision, JSON.stringify(record), id, revision)
    if (result.changes === 0) throw new Error('dsh-requirements: revision conflict; read the requirement again before editing')
    return record
  }

  /** Close the owned connection; the Cordis effect invokes this on unload. */
  close(): void { this.db.close() }

  /**
   * Reserve a single active assignment against an exact requirement revision.
   * @param record - complete dispatch snapshot before starting an external agent.
   * @returns the reserved assignment; throws on stale revision or active work.
   */
  reserve(record: Dispatch): Dispatch {
    const result = this.db.prepare(`INSERT INTO dispatches
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM requirements WHERE id = ? AND revision = ?)`)
      .run(record.id, record.requirementId, record.state, JSON.stringify(record), record.requirementId, record.requirementRevision)
    if (result.changes === 0) throw new Error('dsh-requirements: revision conflict; read the requirement again before dispatching')
    return record
  }

  /**
   * Commit an attempt's terminal outcome independently of requirement acceptance.
   * @param record - terminal assignment fields.
   */
  settle(record: Dispatch): void {
    this.db.prepare('UPDATE dispatches SET state = ?, record = ? WHERE id = ?').run(record.state, JSON.stringify(record), record.id)
  }

  /**
   * Read assignment history without restarting external work.
   * @param id - exact requirement id.
   * @returns attempts in creation order.
   */
  dispatches(id: RequirementId): Dispatch[] {
    return this.db.prepare('SELECT record FROM dispatches WHERE requirement_id = ? ORDER BY rowid').all(id).map(row => {
      if (typeof row.record !== 'string') throw new Error('dsh-requirements: invalid dispatch record')
      const input = parseObject(row.record)
      if (!Object.hasOwn(input, 'finishedAt')) throw new Error('dsh-requirements: missing dispatch finishedAt')
      const value = dispatchSchema(input)
      const { resumedFrom, ...dispatch } = value
      const session = Object.hasOwn(input, 'session') ? decodeNativeSession(value.provider, input.session) : undefined
      return {
        ...dispatch,
        id: brandString<DispatchId>(value.id),
        requirementId: brandString<RequirementId>(value.requirementId),
        ...(session === undefined ? {} : { session }),
        ...(resumedFrom === undefined ? {} : { resumedFrom: brandString<DispatchId>(resumedFrom) }),
      }
    })
  }

  private decode(row: Record<string, unknown>): Requirement {
    if (typeof row.record !== 'string') throw new Error('dsh-requirements: invalid stored record')
    const record = storedSchema(parseObject(row.record))
    if (record.id !== row.id || record.revision !== row.revision) throw new Error('dsh-requirements: inconsistent stored revision or id')
    return { ...record, id: brandString<RequirementId>(record.id) }
  }
}

function decodeNativeSession(provider: string, value: unknown) {
  const kind = nativeKind(provider)
  if (kind === undefined || typeof value !== 'object' || value === null
    || !('threadId' in value) || !isNativeThreadId(kind, value.threadId)
    || !('cwd' in value) || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) {
    throw new Error('dsh-requirements: invalid saved native session identity or working directory')
  }
  return { threadId: brandString<NativeThreadId>(value.threadId), cwd: value.cwd }
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('dsh-requirements: stored JSON must be an object')
  return value as Record<string, unknown>
}
