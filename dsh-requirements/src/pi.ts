/** One-shot Pi print-mode provider over DSH-managed subprocesses. @module */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Deployment-owned Pi executable, environment, and output limits. */
export interface PiSettings {
  /** Bare executable name or absolute path. */
  command: string
  /** Additional native arguments before the fixed print-mode flags. */
  args: string[]
  /** Explicit additions to the scrubbed subprocess environment. */
  env: Record<string, string>
  /** Maximum stdout/stderr capture size; stdout overflow rejects the result. */
  maxOutputBytes: number
  /** Process-tree termination grace in milliseconds. */
  graceMs: number
}

/**
 * Create a provider that sends the request through stdin to Pi print mode.
 * @param ctx - context carrying the managed subprocess service.
 * @param settings - fully resolved Pi configuration.
 * @returns a one-shot provider with no inherited parent conversation.
 */
export function createPiProvider(ctx: Context, settings: PiSettings): SubagentProvider {
  return {
    name: 'requirements-pi',
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    async start(request) {
      request.signal.throwIfAborted()
      if (request.prompt.some(block => block.type !== 'text')) throw new Error('dsh-requirements: Pi accepts text only')
      const command = await ctx.subprocess.resolveExecutable(settings.command, settings.env, request.signal)
      request.signal.throwIfAborted()
      const handle = ctx.subprocess.spawn({
        argv: [command, ...settings.args, '--print', '--no-session'],
        cwd: request.cwd, env: settings.env, signal: request.signal, graceMs: settings.graceMs,
        stdio: {
          stdin: { data: request.prompt.map(block => block.type === 'text' ? block.text : '').join('\n\n') },
          stdout: { maxBytes: settings.maxOutputBytes }, stderr: { maxBytes: settings.maxOutputBytes },
        },
      })
      const result: Promise<SubagentResult> = handle.done.then(outcome => {
        if (request.signal.aborted) return { output: [], stopReason: 'aborted' }
        const output = handle.collected.stdout?.readFrom(0)
        if (outcome.exitCode !== 0 || outcome.signal !== null || output === undefined || output.lossy || output.text.trim() === '') {
          return { output: [], stopReason: 'error', diagnostic: 'Pi failed, returned empty output, or exceeded maxOutputBytes.' }
        }
        return { output: [{ type: 'text', text: output.text }], stopReason: 'completed' }
      }, () => ({ output: [], stopReason: request.signal.aborted ? 'aborted' : 'error', diagnostic: 'Pi process could not start.' }))
      return {
        id: SessionId(`pi_${randomUUID()}`), result,
        async dispose() {
          handle.terminate()
          await result
          await handle.waitForExit()
        },
      }
    },
  }
}
