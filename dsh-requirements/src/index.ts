/** Durable requirement capture and dispatch to named DSH subagent providers. @module */
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { RequirementStore } from './store.ts'
import { nativeKind, runNativeTurn, type NativeSettings } from './native-session.ts'
import { createPiProvider, type PiSettings } from './pi.ts'
import { createRequirementTools } from './tools.ts'
import type { Dispatch, DispatchId, Requirement, RequirementContent, RequirementFilter, RequirementId } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { requirements: RequirementsService }
}

/** Profile configuration; target names resolve to existing subagent providers. */
export interface Config {
  /** SQLite file; defaults to requirements/requirements.db under the Harness home. */
  databasePath?: string
  /** Complete target-to-provider map; defaults to Codex, OpenCode, and Pi. */
  agents?: Record<string, string>
  /** Default page size; defaults to 20. */
  defaultListLimit?: number
  /** Maximum page size; defaults to 200. */
  maxListLimit?: number
  /** SQLite lock wait in milliseconds; defaults to 5000. */
  busyTimeoutMs?: number
  /** Per-dispatch deadline in milliseconds; defaults to 1800000. */
  dispatchTimeoutMs?: number
  /** Native Pi executable, arguments, environment, and process limits. */
  pi?: Partial<PiSettings>
  /** Native Codex CLI executable, environment, and output limit. */
  codex?: Partial<NativeSettings>
  /** Native Pi CLI settings for the persistent route. */
  piSession?: Partial<NativeSettings>
  /** Native OpenCode CLI settings for the persistent route. */
  opencode?: Partial<NativeSettings>
}

const DEFAULT_AGENTS: Record<string, string> = {
  codex: 'codex', 'codex-session': 'requirements-codex',
  opencode: 'opencode', 'opencode-session': 'requirements-opencode',
  pi: 'requirements-pi', 'pi-session': 'requirements-pi-session',
}
const nativeSettingsSchema = Schema.object({ command: Schema.string(), env: Schema.dict(Schema.string()), maxOutputBytes: Schema.number(), graceMs: Schema.number() })

/** Requirements service and model-tool consumer; providers own external execution. */
export class RequirementsService extends Service {
  static inject = ['tools', 'subagents', 'subprocess', 'workingDirectory']
  static Config: Schema<Config> = Schema.object({
    databasePath: Schema.string(),
    agents: Schema.dict(Schema.string()).default(DEFAULT_AGENTS),
    defaultListLimit: Schema.number(), maxListLimit: Schema.number(),
    busyTimeoutMs: Schema.number(), dispatchTimeoutMs: Schema.number(),
    pi: Schema.object({ command: Schema.string(), args: Schema.array(Schema.string()), env: Schema.dict(Schema.string()), maxOutputBytes: Schema.number(), graceMs: Schema.number() }),
    codex: nativeSettingsSchema,
    piSession: nativeSettingsSchema,
    opencode: nativeSettingsSchema,
  })

  private store: RequirementStore | undefined
  private closing = false
  private readonly active = new Map<AbortController, Promise<Dispatch>>()
  private readonly settings: ReturnType<typeof resolveConfig>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'requirements')
    this.settings = resolveConfig(config)
  }

  protected [Service.init](): void {
    this.store = new RequirementStore(this.settings.databasePath, this.settings.busyTimeoutMs)
    this.ctx.effect(() => async () => {
      this.closing = true
      for (const controller of this.active.keys()) controller.abort()
      await Promise.allSettled(this.active.values())
      this.store?.close()
      this.store = undefined
    }, 'requirements: drain dispatches and close SQLite')
    this.ctx.subagents.registerProvider(createPiProvider(this.ctx, this.settings.pi))
    for (const tool of createRequirementTools(this)) this.ctx.tools.register(tool)
  }

  private database(): RequirementStore {
    if (this.closing || this.store === undefined) throw new Error('dsh-requirements: service is not active')
    return this.store
  }

  /**
   * Create a requirement in draft status with P2 priority unless supplied.
   * @param input - project, title, and optional details.
   * @returns the committed record.
   */
  create(input: Pick<RequirementContent, 'project' | 'title'> & Partial<Omit<RequirementContent, 'project' | 'title' | 'status'>>): Requirement {
    return this.database().create({ project: nonblank(input.project), title: nonblank(input.title), description: input.description ?? '', priority: input.priority ?? 'P2', status: 'draft', acceptanceCriteria: (input.acceptanceCriteria ?? []).map(nonblank) })
  }

  /**
   * Read full requirement details and all assignment attempts.
   * @param id - exact requirement id.
   * @returns the requirement and its dispatch history.
   */
  get(id: RequirementId): { requirement: Requirement; dispatches: Dispatch[] } {
    const store = this.database()
    return { requirement: store.get(id), dispatches: store.dispatches(id) }
  }

  /**
   * Browse requirements by exact filters and literal text search.
   * @param filter - optional filters and offset pagination.
   * @returns a page in priority order.
   */
  list(filter: RequirementFilter): Requirement[] {
    const limit = filter.limit ?? this.settings.defaultListLimit
    const offset = filter.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.settings.maxListLimit || !Number.isSafeInteger(offset) || offset < 0) throw new Error('dsh-requirements: invalid limit or offset')
    return this.database().list({ ...filter, limit, offset })
  }

  /**
   * Edit content or accept a completed implementation explicitly as done.
   * @param id - exact requirement id.
   * @param revision - last observed revision.
   * @param patch - mutable fields to replace.
   * @returns the committed requirement; stale revisions reject.
   */
  update(id: RequirementId, revision: number, patch: Partial<RequirementContent>): Requirement {
    const normalized = { ...patch }
    if (normalized.project !== undefined) normalized.project = nonblank(normalized.project)
    if (normalized.title !== undefined) normalized.title = nonblank(normalized.title)
    if (normalized.acceptanceCriteria !== undefined) normalized.acceptanceCriteria = normalized.acceptanceCriteria.map(nonblank)
    if (Object.keys(normalized).length === 0) throw new Error('dsh-requirements: supply at least one editable field')
    return this.database().update(id, revision, normalized)
  }

  /**
   * Discover configured routing names without starting an agent.
   * @returns target, provider, mount status, and native resume capability.
   */
  agents(): Array<{ target: string; provider: string; available: boolean; resumable: boolean }> {
    return Object.entries(this.settings.agents).map(([target, provider]) => {
      const resumable = nativeKind(provider) !== undefined
      return { target, provider, resumable, available: resumable || this.ctx.subagents.getProvider(provider) !== undefined }
    })
  }

  /**
   * Dispatch an exact requirement revision and persist the external outcome.
   * @param id - requirement to implement; ready or in_progress with acceptance criteria.
   * @param revision - exact content revision the user assigned.
   * @param target - configured agent routing name.
   * @param parent - delegating agent providing workspace and lineage.
   * @param signal - tool cancellation signal.
   * @returns a persisted attempt; completion does not accept the requirement.
   */
  dispatch(id: RequirementId, revision: number, target: string, parent: Agent, signal: AbortSignal): Promise<Dispatch> {
    const provider = this.settings.agents[target]
    if (provider === undefined || (nativeKind(provider) === undefined && this.ctx.subagents.getProvider(provider) === undefined)) {
      throw new Error(`dsh-requirements: agent ${target} is not configured or its provider is unavailable`)
    }
    return this.start(id, revision, { target, provider }, parent, signal)
  }

  /**
   * Send feedback to the exact native session recorded for an earlier dispatch.
   * @param id - requirement that owns the selected dispatch.
   * @param revision - current requirement revision, included in the new turn.
   * @param priorId - recorded dispatch whose thread and directory to reuse.
   * @param feedback - review findings and requested follow-up.
   * @param parent - calling agent.
   * @param signal - cancellation for the new turn.
   * @returns the persisted follow-up attempt; a missing session never starts a new one.
   */
  resume(id: RequirementId, revision: number, priorId: DispatchId, feedback: string, parent: Agent, signal: AbortSignal): Promise<Dispatch> {
    const prior = this.database().dispatches(id).find(attempt => attempt.id === priorId)
    if (prior === undefined || nativeKind(prior.provider) === undefined || prior.session === undefined || prior.state === 'running') {
      throw new Error('dsh-requirements: the selected dispatch has no settled, resumable session')
    }
    if (this.settings.agents[prior.target] !== prior.provider) {
      throw new Error('dsh-requirements: restore the saved agent route before resuming this dispatch')
    }
    if (feedback.trim() === '') throw new Error('dsh-requirements: provide review feedback for the resumed turn')
    return this.start(id, revision, {
      target: prior.target, provider: prior.provider, session: prior.session, resumedFrom: prior.id,
    }, parent, signal, feedback)
  }

  private start(
    id: RequirementId, revision: number, route: Pick<Dispatch, 'target' | 'provider' | 'session' | 'resumedFrom'>,
    parent: Agent, signal: AbortSignal, feedback?: string,
  ): Promise<Dispatch> {
    signal.throwIfAborted()
    const store = this.database()
    const requirement = store.get(id)
    if (!['ready', 'in_progress'].includes(requirement.status) || requirement.acceptanceCriteria.length === 0) throw new Error('dsh-requirements: dispatch requires ready or in_progress with acceptance criteria')
    const attempt = store.reserve({ id: brandString<DispatchId>(`dispatch_${randomUUID()}`), requirementId: id, requirementRevision: revision, ...route, state: 'running', output: '', createdAt: new Date().toISOString(), finishedAt: null })
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(this.settings.dispatchTimeoutMs)])
    const work = this.run(store, attempt, requirement, parent, combined, feedback).finally(() => { this.active.delete(controller) })
    this.active.set(controller, work)
    return work
  }

  private async run(store: RequirementStore, attempt: Dispatch, requirement: Requirement, parent: Agent, signal: AbortSignal, feedback?: string): Promise<Dispatch> {
    const task = `Implement this user requirement in the provided workspace. Report changes, verification, and any unmet acceptance criteria. Completion is subject to user acceptance.\n\n${JSON.stringify(requirement, null, 2)}`
    const prompt = feedback === undefined ? task : `${task}\n\nReview feedback for this follow-up:\n${feedback}`
    const kind = nativeKind(attempt.provider)
    const result = kind !== undefined
      ? await this.runSessionTurn(kind, attempt, parent, signal, prompt)
      : await this.runSubagent(attempt, parent, signal, requirement.title, prompt)
    const terminal = { ...attempt, ...result, finishedAt: new Date().toISOString() }
    store.settle(terminal)
    return terminal
  }

  private async runSessionTurn(kind: NonNullable<ReturnType<typeof nativeKind>>, attempt: Dispatch, parent: Agent, signal: AbortSignal, prompt: string) {
    try {
      const cwd = attempt.session?.cwd ?? await this.ctx.workingDirectory.ensure(parent, signal)
      return await runNativeTurn(this.ctx, kind, this.settings.native[kind], {
        cwd, signal, prompt, ...(attempt.session === undefined ? {} : { resume: attempt.session }),
      })
    } catch (error: unknown) {
      this.ctx.logger.warn('Could not run %s for dispatch %s: %s', kind, attempt.id, error instanceof Error ? error.name : 'unknown error')
      return {
        state: signal.aborted ? 'cancelled' as const : 'failed' as const,
        output: `Could not run ${kind}. Verify the executable, working directory, and native account before retrying.`,
      }
    }
  }

  private async runSubagent(attempt: Dispatch, parent: Agent, signal: AbortSignal, label: string, prompt: string): Promise<Pick<Dispatch, 'state' | 'output'>> {
    try {
      const run = await this.ctx.subagents.startActivation({
        provider: attempt.provider, parent, signal, label, delivery: 'caller',
        prompt: [{ type: 'text', text: prompt }],
      })
      const cancellation = addAbortListener(signal, () => {
        // The same disposal promise is awaited below, including teardown failures.
        void run.dispose().catch(() => {})
      })
      let result
      try {
        result = await run.result
      } finally {
        cancellation[Symbol.dispose]()
        await run.dispose()
      }
      return { state: result.stopReason === 'completed' ? 'completed' : result.stopReason === 'aborted' ? 'cancelled' : 'failed', output: result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }
    } catch {
      return { state: signal.aborted ? 'cancelled' : 'failed', output: 'Dispatch failed; inspect the configured provider and its host logs before retrying.' }
    }
  }
}

function nonblank(value: string): string {
  if (value.trim() === '') throw new Error('dsh-requirements: project, title, and acceptance criteria must not be blank')
  return value.trim()
}

function resolveConfig(config: Config) {
  const agents = config.agents ?? DEFAULT_AGENTS
  for (const [target, provider] of Object.entries(agents)) { nonblank(target); nonblank(provider) }
  if (config.databasePath !== undefined) nonblank(config.databasePath)
  const settings = {
    databasePath: config.databasePath === undefined ? join(resolveDshHome(), 'requirements', 'requirements.db') : resolve(expandHomePath(config.databasePath)),
    agents, defaultListLimit: config.defaultListLimit ?? 20, maxListLimit: config.maxListLimit ?? 200,
    busyTimeoutMs: config.busyTimeoutMs ?? 5000, dispatchTimeoutMs: config.dispatchTimeoutMs ?? 1_800_000,
    pi: { command: config.pi?.command ?? 'pi', args: config.pi?.args ?? [], env: config.pi?.env ?? {}, maxOutputBytes: config.pi?.maxOutputBytes ?? 1_048_576, graceMs: config.pi?.graceMs ?? 3000 },
    native: {
      codex: resolveNativeSettings('codex', config.codex),
      pi: resolveNativeSettings('pi', config.piSession),
      opencode: resolveNativeSettings('opencode', config.opencode),
    },
  }
  for (const value of [
    settings.defaultListLimit, settings.maxListLimit, settings.busyTimeoutMs, settings.dispatchTimeoutMs, settings.pi.maxOutputBytes, settings.pi.graceMs,
    ...Object.values(settings.native).flatMap(native => [native.maxOutputBytes, native.graceMs]),
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('dsh-requirements: numeric configuration must be a positive 32-bit integer')
  }
  if (settings.defaultListLimit > settings.maxListLimit) throw new Error('dsh-requirements: defaultListLimit exceeds maxListLimit')
  nonblank(settings.pi.command)
  return settings
}

function resolveNativeSettings(command: string, config?: Partial<NativeSettings>): NativeSettings {
  return {
    command: nonblank(config?.command ?? command), env: config?.env ?? {},
    maxOutputBytes: config?.maxOutputBytes ?? 8_388_608, graceMs: config?.graceMs ?? 3000,
  }
}

export default RequirementsService
