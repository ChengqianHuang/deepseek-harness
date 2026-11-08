/** Requirements persisted independently of conversation sessions. @module */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier returned by requirement creation and lookup. */
export type RequirementId = Branded<'RequirementId'>

/** Identity of one dispatch attempt, including failed attempts. */
export type DispatchId = Branded<'RequirementDispatchId'>

/** Native agent session identity reported by its CLI. */
export type NativeThreadId = Branded<'RequirementsNativeThreadId'>

/** Exact native session and working directory used to send another turn. */
export interface NativeSession {
  threadId: NativeThreadId
  cwd: string
}

/** Persisted assignment; completion requests human acceptance separately. */
export interface Dispatch {
  id: DispatchId
  requirementId: RequirementId
  requirementRevision: number
  target: string
  provider: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  output: string
  createdAt: string
  finishedAt: string | null
  /** Present when a native CLI supplied a persistent session identity. */
  session?: NativeSession
  /** Prior attempt selected for the current turn. */
  resumedFrom?: DispatchId
}

/** Lifecycle values; completed records may be reopened through an update. */
export const STATUSES = ['draft', 'ready', 'in_progress', 'done', 'cancelled'] as const
/** Priority order, with P0 the most urgent. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const

/** Editable requirement fields; project is an exact grouping label. */
export interface RequirementContent {
  project: string
  title: string
  description: string
  priority: typeof PRIORITIES[number]
  status: typeof STATUSES[number]
  acceptanceCriteria: string[]
}

/** Durable record; revision must accompany edits to prevent lost updates. */
export interface Requirement extends RequirementContent {
  id: RequirementId
  revision: number
  createdAt: string
  updatedAt: string
}

/** Optional exact filters and literal substring search. */
export interface RequirementFilter {
  project?: string | undefined
  status?: RequirementContent['status'] | undefined
  priority?: RequirementContent['priority'] | undefined
  query?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}
