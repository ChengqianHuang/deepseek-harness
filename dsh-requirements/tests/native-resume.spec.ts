import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'
import Requirements from '../src/index.ts'
import type { DispatchId } from '../src/types.ts'
import { runtime } from './runtime.ts'

it.skipIf(process.platform === 'win32').each([
  ['codex', 'codex', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
  ['pi', 'piSession', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
  ['opencode', 'opencode', 'ses_11111111', 'ses_22222222'],
] as const)('reopens only the saved %s session in its original workspace', async (kind, key, session, other) => {
  const { ctx, parent, root, fiber } = await runtime(onTestFinished)
  const cli = join(root, 'fixture-agent')
  await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const kind = ${JSON.stringify(kind)};
const resume = kind === 'codex' ? args.includes('resume') : args.includes('--session');
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(${JSON.stringify(await ctx.workingDirectory.ensure(parent))})) process.exit(2);
if (resume && (kind === 'codex' ? args.at(-2) : args[args.indexOf('--session')+1]) !== ${JSON.stringify(session)}) process.exit(3);
if (resume && !prompt.includes('Review feedback')) process.exit(4);
const id = prompt.includes('MISMATCH') ? ${JSON.stringify(other)} : ${JSON.stringify(session)};
const text = resume ? 'same thread' : 'first turn';
const events = kind === 'codex'
  ? [{type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed'}]
  : kind === 'pi'
    ? [{type:'session',id},{type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}},{type:'agent_settled',aborted:false}]
    : [{type:'step_start',sessionID:id},{type:'text',sessionID:id,part:{text}}];
for (const event of events) console.log(JSON.stringify(event));
`, { mode: 0o700 })
  const settings = { databasePath: join(root, 'requirements.db'), [key]: { command: cli } }
  await fiber.dispose()
  const firstFiber = await ctx.plugin(Requirements, settings)
  const draft = ctx.requirements.create({ project: 'DSH', title: 'Resume', acceptanceCriteria: ['Return to the same thread'] })
  const ready = ctx.requirements.update(draft.id, draft.revision, { status: 'ready' })
  const signal = new AbortController().signal
  const first = await ctx.requirements.dispatch(ready.id, ready.revision, `${kind}-session`, parent, signal)
  expect(first).toMatchObject({ state: 'completed', session: { threadId: session }, output: 'first turn' })
  await firstFiber.dispose()

  await ctx.plugin(Requirements, settings)
  const elsewhere = join(root, 'different-project')
  await mkdir(elsewhere)
  const adapter = new MockAdapter([
    toolCallResponse('resume', 'requirement_resume', {
      id: ready.id, expectedRevision: ready.revision, dispatchId: first.id, feedback: 'Run the regression again.',
    }),
    textResponse('The agent completed the follow-up.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const reviewer = await ctx.agentLoop.create(SessionId('reviewer'), { provider: 'mock', model: 'mock' }, { cwd: elsewhere })
  reviewer.followup(createUserMessage({ content: [{ type: 'text', text: 'Send the regression feedback to the original session.' }], source: { kind: 'user' } }))
  await reviewer.whenIdle()
  const resumed = ctx.requirements.get(ready.id).dispatches[1]
  expect(resumed).toMatchObject({ state: 'completed', resumedFrom: first.id, session: first.session, output: 'same thread' })
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('same thread')

  const mismatch = await ctx.requirements.resume(ready.id, ready.revision, first.id, 'MISMATCH', reviewer, signal)
  expect(mismatch).toMatchObject({ state: 'failed', session: first.session, output: expect.stringContaining('did not confirm') })
  expect(ctx.requirements.get(ready.id)).toMatchObject({ requirement: { status: 'ready' }, dispatches: [first, resumed, mismatch] })
  expect(() => ctx.requirements.resume(ready.id, ready.revision, brandString<DispatchId>('unknown'), 'Continue', reviewer, signal)).toThrow('no settled, resumable')
})
