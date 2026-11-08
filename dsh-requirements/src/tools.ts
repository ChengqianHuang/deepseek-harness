/** Typed model tools with pure generic call cards and persisted result text. @module */
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { RequirementsService } from './index.ts'
import { PRIORITIES, STATUSES, type DispatchId, type RequirementId } from './types.ts'

const contentParameters = {
  project: { type: 'string', description: 'Exact project grouping label.' },
  title: { type: 'string', description: 'Concise user requirement.' },
  description: { type: 'string', description: 'User need, context, and scope.' },
  priority: { type: 'string', enum: PRIORITIES, description: 'P0 most urgent through P3 least urgent; creation defaults to P2.' },
  acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Observable acceptance criteria; replace the whole list when editing.' },
} as const

const requirementSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, revision: { type: 'number', required: true },
    project: { type: 'string', required: true }, title: { type: 'string', required: true },
    description: { type: 'string', required: true }, priority: { type: 'string', required: true },
    status: { type: 'string', required: true }, acceptanceCriteria: { type: 'array', items: { type: 'string' }, required: true },
    createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

const dispatchSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, requirementId: { type: 'string', required: true },
    requirementRevision: { type: 'number', required: true }, target: { type: 'string', required: true },
    provider: { type: 'string', required: true }, state: { type: 'string', required: true },
    output: { type: 'string', required: true }, createdAt: { type: 'string', required: true },
    finishedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    session: { type: 'object', additionalProperties: false, properties: {
      threadId: { type: 'string', required: true }, cwd: { type: 'string', required: true },
    } },
    resumedFrom: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

function text(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build requirement capture, browsing, editing, routing discovery, and dispatch tools.
 * @param service - the active requirements service.
 * @returns definitions registered by the owning Cordis plugin fiber.
 */
export function createRequirementTools(service: RequirementsService): ToolDefinition[] {
  return [
    defineTool({
      name: 'requirement_create',
      description: 'Capture a user requirement in draft status. Record the project, scope, priority, and observable acceptance criteria before assigning implementation.',
      parameters: { ...contentParameters, project: { ...contentParameters.project, required: true }, title: { ...contentParameters.title, required: true } },
      output: { schema: requirementSchema, render: (_args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return service.create({ project: args.project, title: args.title, ...(args.description === undefined ? {} : { description: args.description }), ...(args.priority === undefined ? {} : { priority: args.priority }), ...(args.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: args.acceptanceCriteria }) })
      },
      presentCall: args => ({ card: 'generic', title: 'Capture requirement', kind: 'other', rawInput: args.title }),
    }),
    defineTool({
      name: 'requirement_get', description: 'Read a requirement, its current revision, and every dispatch attempt. A completed dispatch still requires user acceptance; a running record after a host crash has an unknown external outcome and must not be retried automatically.',
      parameters: { id: { type: 'string', required: true, description: 'Exact requirement id.' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { requirement: { ...requirementSchema, required: true }, dispatches: { type: 'array', items: dispatchSchema, required: true } } }, render: (_args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) { exec.signal.throwIfAborted(); return service.get(brandString<RequirementId>(args.id)) },
      presentCall: args => ({ card: 'generic', title: 'Read requirement', kind: 'other', rawInput: args.id }),
    }),
    defineTool({
      name: 'requirement_list', description: 'Browse user requirements in P0–P3 order. Search is literal substring matching across title, description, and acceptance criteria; other filters match exactly. Use offset pagination.',
      parameters: {
        project: contentParameters.project,
        status: { type: 'string', enum: STATUSES }, priority: contentParameters.priority,
        query: { type: 'string' }, limit: { type: 'number', description: 'Positive page size, subject to profile maxListLimit.' }, offset: { type: 'number', description: 'Nonnegative offset; defaults to zero.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { requirements: { type: 'array', items: requirementSchema, required: true } } }, render: (_args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) { exec.signal.throwIfAborted(); return { requirements: service.list(args) } },
      presentCall: args => ({ card: 'generic', title: 'Browse requirements', kind: 'other', rawInput: args.query ?? args.project ?? '' }),
    }),
    defineTool({
      name: 'requirement_update', description: 'Edit the requirement using its last observed revision. Set ready only after scope and acceptance criteria are agreed. Set done only after the user accepts implementation. Stale revisions fail; read again before retrying.',
      parameters: {
        id: { type: 'string', required: true }, expectedRevision: { type: 'number', required: true },
        ...contentParameters, status: { type: 'string', enum: STATUSES },
      },
      output: { schema: requirementSchema, render: (_args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const keys = ['project', 'title', 'description', 'priority', 'status', 'acceptanceCriteria'] as const
        const patch = Object.fromEntries(keys.flatMap(key => args[key] === undefined ? [] : [[key, args[key]]]))
        return service.update(brandString<RequirementId>(args.id), args.expectedRevision, patch)
      },
      presentCall: args => ({ card: 'generic', title: 'Edit requirement', kind: 'other', rawInput: args.id }),
    }),
    defineTool({
      name: 'requirement_agents', description: 'Discover configured requirement routes, whether each is mounted, and whether it can resume its saved sessions. This does not verify executable installation, authentication, or model availability.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { agents: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { target: { type: 'string', required: true }, provider: { type: 'string', required: true }, available: { type: 'boolean', required: true }, resumable: { type: 'boolean', required: true } } } } } }, render: (_args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(_args, exec) { exec.signal.throwIfAborted(); return { agents: service.agents() } },
      presentCall: () => ({ card: 'generic', title: 'Discover requirement agents', kind: 'other', rawInput: '' }),
    }),
    defineTool({
      name: 'requirement_dispatch', description: 'Assign an agreed user requirement to a configured agent. Choose a persistent route such as codex-session, pi-session, or opencode-session when later feedback should go to the same session. Requires ready or in_progress status, acceptance criteria, and the current revision. Runs in the calling agent workspace and waits for the result. Only one active attempt per requirement is allowed. Execution can change files; completed means awaiting user acceptance, not done.',
      parameters: { id: { type: 'string', required: true }, expectedRevision: { type: 'number', required: true }, target: { type: 'string', required: true, description: 'A target returned by requirement_agents.' } },
      output: { schema: dispatchSchema, render: (_args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('dsh-requirements: dispatch requires a calling agent')
        return service.dispatch(brandString<RequirementId>(args.id), args.expectedRevision, args.target, exec.agent, exec.signal)
      },
      presentCall: args => ({ card: 'generic', title: 'Dispatch requirement', kind: 'other', rawInput: `${args.id} → ${args.target}` }),
    }),
    defineTool({
      name: 'requirement_resume',
      description: 'Send review feedback to the exact agent session saved by a previous requirement dispatch. Use the dispatch id from requirement_get and the current requirement revision. The tool reuses the saved agent and workspace and fails if the session cannot be restored.',
      parameters: {
        id: { type: 'string', required: true },
        expectedRevision: { type: 'number', required: true },
        dispatchId: { type: 'string', required: true, description: 'An earlier dispatch for this requirement with a saved session.' },
        feedback: { type: 'string', required: true, description: 'Unmet acceptance criteria and requested corrections.' },
      },
      output: { schema: dispatchSchema, render: (_args, value) => text(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('dsh-requirements: resume requires a calling agent')
        return service.resume(brandString<RequirementId>(args.id), args.expectedRevision, brandString<DispatchId>(args.dispatchId), args.feedback, exec.agent, exec.signal)
      },
      presentCall: args => ({ card: 'generic', title: 'Resume requirement dispatch', kind: 'other', rawInput: args.dispatchId }),
    }),
  ]
}
