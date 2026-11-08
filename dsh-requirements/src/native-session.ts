/** Persistent native agent turns over DSH-managed subprocesses. @module */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { NativeSession, NativeThreadId } from './types.ts'

/** Deployment settings for an installed native CLI. */
export interface NativeSettings {
  /** Executable name or absolute path. */
  command: string
  /** Explicit environment, including native account and session storage overrides. */
  env: Record<string, string>
  /** Bounded JSONL capture size in bytes. */
  maxOutputBytes: number
  /** Process-tree termination grace in milliseconds. */
  graceMs: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPENCODE_ID = /^ses_[a-z0-9]+$/i

/** Native routes reserve distinct names from the subagent registry. */
export const NATIVE_ROUTES = {
  'requirements-codex': 'codex', 'requirements-pi-session': 'pi', 'requirements-opencode': 'opencode',
} as const

type NativeKind = typeof NATIVE_ROUTES[keyof typeof NATIVE_ROUTES]

/** Resolve a registered native route by name.
 * @param route - deployment-owned route name.
 * @returns the native CLI kind, or undefined for subagent registry routes.
 */
export function nativeKind(route: string): NativeKind | undefined {
  if (Object.hasOwn(NATIVE_ROUTES, route)) return NATIVE_ROUTES[route as keyof typeof NATIVE_ROUTES]
}

/** Validate an ID using its owning CLI's syntax.
 * @param kind - CLI that issued the ID.
 * @param value - untrusted saved or returned identity.
 * @returns whether the value can be used as an exact session selector.
 */
export function isNativeThreadId(kind: NativeKind, value: unknown): value is string {
  return typeof value === 'string' && (kind === 'opencode' ? OPENCODE_ID : UUID).test(value)
}

interface TurnRequest {
  cwd: string
  prompt: string
  signal: AbortSignal
  resume?: NativeSession
}

interface TurnResult {
  state: 'completed' | 'failed' | 'cancelled'
  output: string
  session?: NativeSession
}

/** Run one persistent turn and verify the CLI returned the requested session.
 * @param ctx - the context carrying managed subprocesses.
 * @param kind - owning native CLI.
 * @param settings - executable, environment, and capture budget.
 * @param request - working directory, text, cancellation, and optional existing session.
 * @returns the terminal outcome and any thread identified by the CLI.
 */
export async function runNativeTurn(ctx: Context, kind: NativeKind, settings: NativeSettings, request: TurnRequest): Promise<TurnResult> {
  const { cwd, prompt, resume, signal } = request
  const command = await ctx.subprocess.resolveExecutable(settings.command, settings.env, signal)
  signal.throwIfAborted()
  const id = resume?.threadId
  const selector = id === undefined ? [] : ['--session', id]
  const args = kind === 'codex'
    ? ['-a', 'never', '-s', 'workspace-write', 'exec', ...(id === undefined ? ['--json', '-'] : ['resume', '--json', id, '-'])]
    : kind === 'pi'
      ? ['--mode', 'json', ...selector]
      : ['run', '--standalone', '--format', 'json', ...selector]
  const handle = ctx.subprocess.spawn({
    argv: [command, ...args],
    cwd, env: settings.env, signal, graceMs: settings.graceMs,
    stdio: {
      stdin: { data: prompt },
      stdout: { maxBytes: settings.maxOutputBytes },
      stderr: { maxBytes: settings.maxOutputBytes },
    },
  })
  const outcome = await handle.done.finally(() => handle.waitForExit())
  const capture = handle.collected.stdout?.readFrom(0)
  const turn = capture === undefined || capture.lossy ? undefined : parseTurn(kind, capture.text)
  const session = turn?.id === undefined ? undefined : { threadId: turn.id, cwd }
  if (resume !== undefined && session?.threadId !== resume.threadId) {
    return {
      state: signal.aborted ? 'cancelled' : 'failed',
      output: `${kind} did not confirm the original session. Verify the saved session, account, and workspace before retrying.`,
      session: resume,
    }
  }
  const identity = session === undefined ? {} : { session }
  if (signal.aborted) return { state: 'cancelled', output: '', ...identity }
  if (outcome.exitCode !== 0 || outcome.signal !== null || session === undefined || turn?.completed !== true || turn.output.trim() === '') {
    return { state: 'failed', output: `${kind} did not return a complete result. Check the CLI and its authentication before retrying.`, ...identity }
  }
  return { state: 'completed', output: turn.output, session }
}

function parseTurn(kind: NativeKind, text: string): { id?: NativeThreadId; completed: boolean; output: string } | undefined {
  let id: NativeThreadId | undefined
  // OpenCode v2 can exit successfully without emitting step_finish.
  let completed = kind === 'opencode'
  let piStop: unknown
  let output = ''
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
    if (!isRecord(event)) return undefined
    const candidate = kind === 'codex' && event.type === 'thread.started' ? event.thread_id
      : kind === 'pi' && event.type === 'session' ? event.id
        : kind === 'opencode' ? event.sessionID : undefined
    if (candidate !== undefined) {
      if (!isNativeThreadId(kind, candidate) || (id !== undefined && id !== candidate)) return undefined
      id = brandString<NativeThreadId>(candidate)
    }
    switch (kind) {
      case 'codex':
        if (event.type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') output = event.item.text
        if (event.type === 'turn.completed') completed = true
        if (event.type === 'turn.failed') completed = false
        break
      case 'pi':
        if (event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
          piStop = event.message.stopReason
          output = Array.isArray(event.message.content)
            ? event.message.content.flatMap((part: unknown) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
            : ''
        }
        if (event.type === 'agent_settled') completed = event.aborted === false && piStop === 'stop'
        break
      case 'opencode':
        if (event.type === 'text' && isRecord(event.part) && typeof event.part.text === 'string') output += event.part.text
        if (event.type === 'error') completed = false
        break
    }
  }
  return { ...(id === undefined ? {} : { id }), completed, output }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
