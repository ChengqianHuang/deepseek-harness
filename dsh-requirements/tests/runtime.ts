/** Each test owns its Context, temporary files, and managed child processes. @module */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import Requirements, { type Config } from '../src/index.ts'

/**
 * Mount real service registries and an idle parent Agent without model calls.
 * @param onCleanup - Vitest per-test cleanup registrar.
 * @param config - optional deployment overrides.
 * @returns isolated runtime and requirement service fiber.
 */
export async function runtime(onCleanup: (fn: () => Promise<void>) => void, config: Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-requirements-'))
  const ctx = new Context()
  onCleanup(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(AgentLoop, { agents: [] })
  const fiber = await ctx.plugin(Requirements, { databasePath: join(root, 'requirements.db'), ...config })
  const parent = await ctx.agentLoop.create(SessionId('requirements-parent'), {}, { cwd: root })
  return { ctx, root, parent, fiber, service: ctx.requirements }
}
