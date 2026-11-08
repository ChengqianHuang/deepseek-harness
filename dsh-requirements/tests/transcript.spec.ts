import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'
import { runtime } from './runtime.ts'

it('logs requirement facts and routing availability before the next model request', async ({ onTestFinished }) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'))
  onTestFinished(() => vi.useRealTimers())
  const { ctx, root } = await runtime(onTestFinished)
  const fixture = {
    id: 'req_fixture', revision: 1, project: 'DSH', title: '分发用户需求',
    description: '用户选择 Codex、OpenCode 或 Pi 执行需求。', priority: 'P1', status: 'draft',
    acceptanceCriteria: ['保存分发目标与执行结果', '执行完成后等待用户验收'],
    createdAt: '2026-11-04T12:00:00.000Z', updatedAt: '2026-11-04T12:00:00.000Z',
  }
  const db = new DatabaseSync(join(root, 'requirements.db'))
  try { db.prepare('INSERT INTO requirements VALUES (?, ?, ?)').run(fixture.id, 1, JSON.stringify(fixture)) } finally { db.close() }
  const adapter = new MockAdapter([
    toolCallResponse('read', 'requirement_get', { id: fixture.id }),
    toolCallResponse('ready', 'requirement_update', { id: fixture.id, expectedRevision: 1, status: 'ready' }),
    toolCallResponse('agents', 'requirement_agents', {}),
    textResponse('需求已就绪。Codex 和 OpenCode 的 provider 尚未配置；Pi 仍需验证安装和认证。'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('requirements-transcript'), { provider: 'mock', model: 'mock' }, { cwd: root })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '把分发用户需求设为就绪，并查看可用 agent。' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [{ role: event.data.message.role, source: event.data.message.source, content: event.data.message.content }] : [])
  expect(results).toMatchSnapshot()
  expect(results).toHaveLength(3)
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('保存分发目标与执行结果')
  expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('requirements-pi')
})
