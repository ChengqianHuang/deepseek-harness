import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished as cleanup } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ResolvedSubagentStartRequest, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { RequirementStore } from '../src/store.ts'
import { createRequirementTools } from '../src/tools.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { runtime } from './runtime.ts'

const capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }

it('persists content, pages filters, and refuses stale edits and missing acceptance criteria', async ({ onTestFinished }) => {
  const { service, root, fiber } = await runtime(onTestFinished)
  const first = service.create({ project: 'DSH', title: ' 支持中文需求 ', priority: 'P1' })
  service.create({ project: 'Other', title: '100% coverage', priority: 'P0' })
  expect(service.list({ query: '中文', project: 'DSH' })).toEqual([first])
  expect(service.list({ query: '%' })).toHaveLength(1)
  expect(service.list({ limit: 1, offset: 1 })[0]?.id).toBe(first.id)
  expect(() => service.list({ limit: 0 })).toThrow('limit')
  expect(() => service.update(first.id, 1, { status: 'ready' })).toThrow('acceptance criteria')
  const ready = service.update(first.id, 1, { status: 'ready', acceptanceCriteria: ['能按项目查询'] })
  expect(() => service.update(first.id, 1, { title: 'stale' })).toThrow('revision conflict')
  expect(() => service.create({ project: 'DSH', title: ' ' })).toThrow('blank')
  await fiber.dispose()
  const store = new RequirementStore(join(root, 'requirements.db'), 1000)
  onTestFinished(() => store.close())
  expect(store.get(first.id)).toEqual(ready)
  expect(() => service.get(first.id)).toThrow('not active')
})

it.each(['codex', 'opencode', 'pi'])('routes a versioned requirement to %s and retains user acceptance', async (target) => {
  const provider = `test-${target}`
  const { ctx, service, parent } = await runtime(cleanup, { agents: { [target]: provider } })
  const requests: ResolvedSubagentStartRequest[] = []
  let disposed = false
  ctx.subagents.registerProvider({
    name: provider, capabilities, inheritsParentContext: false,
    async start(request) {
      requests.push(request)
      return { id: SessionId(`child-${target}`), result: Promise.resolve({ output: [{ type: 'text', text: `${target}: implemented and tested` }], stopReason: 'completed' }), async dispose() { disposed = true } }
    },
  })
  const draft = service.create({ project: 'DSH', title: 'Route requirement', acceptanceCriteria: ['Returns result'] })
  const ready = service.update(draft.id, 1, { status: 'ready' })
  expect(await service.dispatch(ready.id, ready.revision, target, parent, new AbortController().signal)).toMatchObject({ state: 'completed', target, provider })
  expect(requests).toHaveLength(1)
  expect(disposed).toBe(true)
  expect(service.get(ready.id).requirement.status).toBe('ready')
})

it('rejects duplicate dispatch, persists results, and keeps requirement acceptance separate', async ({ onTestFinished }) => {
  const { ctx, service, parent } = await runtime(onTestFinished, { agents: { codex: 'fake' } })
  let complete!: (value: SubagentResult) => void
  let observed: ResolvedSubagentStartRequest | undefined
  let disposed = false
  const result = new Promise<SubagentResult>(resolve => { complete = resolve })
  ctx.subagents.registerProvider({ name: 'fake', capabilities, inheritsParentContext: false, async start(request) {
    observed = request
    request.signal.addEventListener('abort', () => complete({ output: [], stopReason: 'aborted' }), { once: true })
    return { id: SessionId('fake-child'), result, async dispose() { disposed = true } }
  } })
  const draft = service.create({ project: 'DSH', title: '需求分发', acceptanceCriteria: ['记录执行结果'] })
  expect(() => service.dispatch(draft.id, 1, 'codex', parent, new AbortController().signal)).toThrow('ready')
  const ready = service.update(draft.id, 1, { status: 'ready' })
  expect(() => service.dispatch(ready.id, 1, 'codex', parent, new AbortController().signal)).toThrow('revision conflict')
  const pending = service.dispatch(ready.id, ready.revision, 'codex', parent, new AbortController().signal)
  expect(service.get(ready.id).dispatches[0]?.state).toBe('running')
  expect(() => service.dispatch(ready.id, ready.revision, 'codex', parent, new AbortController().signal)).toThrow()
  complete({ output: [{ type: 'text', text: 'Implemented; focused tests pass.' }], stopReason: 'completed' })
  expect(await pending).toMatchObject({ state: 'completed', target: 'codex', requirementRevision: ready.revision })
  expect(observed?.prompt).toEqual([{ type: 'text', text: expect.stringContaining('记录执行结果') }])
  expect(disposed).toBe(true)
  expect(service.get(ready.id)).toMatchObject({ requirement: { status: 'ready' }, dispatches: [{ state: 'completed', output: 'Implemented; focused tests pass.' }] })
})

it('unloads only after cancelling active work and saving its outcome', async ({ onTestFinished }) => {
  const { ctx, service, parent, fiber, root } = await runtime(onTestFinished, { agents: { codex: 'fake' } })
  let started!: () => void
  const publication = new Promise<void>(resolve => { started = resolve })
  let disposed = false
  ctx.subagents.registerProvider({ name: 'fake', capabilities, inheritsParentContext: false, async start(request) {
    const result = new Promise<SubagentResult>(resolve => {
      request.signal.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted' }), { once: true })
    })
    started()
    return { id: SessionId('cancel-child'), result, async dispose() { disposed = true } }
  } })
  const draft = service.create({ project: 'DSH', title: 'Cancel', acceptanceCriteria: ['Stop child'] })
  const ready = service.update(draft.id, 1, { status: 'ready' })
  const work = service.dispatch(ready.id, ready.revision, 'codex', parent, new AbortController().signal)
  await publication
  await fiber.dispose()
  expect((await work).state).toBe('cancelled')
  expect(disposed).toBe(true)
  const store = new RequirementStore(join(root, 'requirements.db'), 1000)
  onTestFinished(() => store.close())
  expect(store.dispatches(ready.id)[0]?.state).toBe('cancelled')
  expect(ctx.subagents.getProvider('requirements-pi')).toBeUndefined()
})

it('uses the real managed subprocess path for Pi print mode', async ({ onTestFinished }) => {
  const { root, service, parent } = await runtime(onTestFinished, { pi: { command: process.execPath, args: ['--input-type=module', '-e', 'let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(input.includes("Pi acceptance") ? "Pi implemented" : "missing prompt")', '--'] } })
  const draft = service.create({ project: 'DSH', title: 'Pi task', acceptanceCriteria: ['Pi acceptance'] })
  const ready = service.update(draft.id, 1, { status: 'ready' })
  const result = await service.dispatch(ready.id, ready.revision, 'pi', parent, new AbortController().signal)
  expect(result).toMatchObject({ state: 'completed', output: 'Pi implemented\n' })
  expect(root).toBe(parent.session.header.cwd)
})

it('records unavailable executables as failed attempts without accepting the requirement', async ({ onTestFinished }) => {
  const { root, service, parent } = await runtime(onTestFinished, { pi: { command: 'dsh-requirements-missing-executable' } })
  const draft = service.create({ project: 'DSH', title: 'Missing Pi', acceptanceCriteria: ['Result'] })
  const ready = service.update(draft.id, 1, { status: 'ready' })
  expect((await service.dispatch(ready.id, ready.revision, 'pi', parent, new AbortController().signal)).state).toBe('failed')
  const foreignPath = join(root, 'foreign.db')
  const db = new DatabaseSync(foreignPath)
  db.exec('CREATE TABLE other (id TEXT)')
  db.close()
  expect(() => new RequirementStore(foreignPath, 1000)).toThrow('foreign database')
  await writeFile(join(root, 'not-a-database'), 'invalid')
  expect(() => new RequirementStore(join(root, 'not-a-database'), 1000)).toThrow()
})

it('ignores undeclared JSON fields when editing requirement content', async ({ onTestFinished }) => {
  const { service } = await runtime(onTestFinished)
  const draft = service.create({ project: 'DSH', title: 'Original' })
  const tool = createRequirementTools(service).find(value => value.name === 'requirement_update')!
  await tool.execute({ id: draft.id, expectedRevision: 1, title: 'Edited', createdAt: 'forged', revision: 999 }, { signal: new AbortController().signal } as ToolRunContext)
  expect(service.get(draft.id).requirement).toMatchObject({ title: 'Edited', revision: 2, createdAt: draft.createdAt })
})

it.each([
  ['failed exit', 'console.log("partial"); process.exitCode = 1', 1024],
  ['empty output', '', 1024],
  ['truncated output', 'console.log("x".repeat(10000))', 32],
] as const)('rejects Pi %s as an unsuccessful implementation', async (_label, code, maxOutputBytes) => {
  const { service, parent } = await runtime(cleanup, { pi: { command: process.execPath, args: ['--input-type=module', '-e', code, '--'], maxOutputBytes } })
  const draft = service.create({ project: 'DSH', title: 'Pi failure', acceptanceCriteria: ['Complete output'] })
  const ready = service.update(draft.id, 1, { status: 'ready' })
  const result = await service.dispatch(ready.id, ready.revision, 'pi', parent, new AbortController().signal)
  expect(result.state).toBe('failed')
  expect(result.output).toBe('')
})
