---
description: "Capture user requirements and assign versioned implementation work to Codex, OpenCode, Pi, or other DSH subagent providers."
kind: "package-bundle"
---

# @deepseek-ai/dsh-requirements

English | [中文](README.zh.md)

## Summary

Manage user requirements by project, priority, status, and acceptance criteria, then assign an agreed revision to a named agent. SQLite retains requirement content and dispatch outcomes across sessions. Choose a persistent route to send later feedback to the same Codex, Pi, or OpenCode session. Agent completion and user acceptance are separate: dispatch never marks a requirement done.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

### Development in this checkout

Node.js `^22.19.0 || >=24.0.0` and the parent Harness checkout's installed development dependencies and built declarations are required. This directory is outside the Harness pnpm workspace; it does not modify the shipped profiles. Run from the Harness repository root:

```sh
pnpm --dir dsh-requirements install --ignore-workspace --config.auto-install-peers=false
pnpm --dir dsh-requirements build
pnpm --dir dsh-requirements typecheck
pnpm --dir dsh-requirements test
```

### Add to a profile

The following installation and composition were verified with an isolated `DSH_HOME` and the source CLI. Replace the absolute path with this checkout's location. The parent profile must already provide `tools`, `subagents`, `subprocess`, and `workingDirectory`, as the shipped base-backed profiles do.

```sh
pnpm dsh plugin --profile headless add --config.auto-install-peers=false /Users/hcq/deepseek-harness/dsh-requirements
pnpm dsh --profile headless --patch dsh-requirements/examples/providers.patch.yml --dump-config
```

The bundle inserts the `requirements` row. The example overlay adds the one-shot Codex and OpenCode provider rows. For persistent routes, install and authenticate the native CLI and make it available to DSH through `PATH` or the corresponding `command` setting. Discovery reports mounted routes; executable and account checks occur when the route runs.

### User workflow

Ask the DSH agent to capture a requirement, clarify its scope and acceptance criteria, and set it ready. Select a target returned by `requirement_agents`, then dispatch the current revision. Inspect the returned implementation and verification summary before asking to mark the requirement done. Different requirements can be dispatched independently; each requirement permits only one active attempt.

Example: “Send this requirement to `codex-session`. After review, send the failed acceptance criteria back to the original session.” DSH uses `requirement_resume` with the dispatch ID and current requirement revision. It uses the saved working directory and records a new attempt linked to the prior dispatch. A missing session or mismatched thread fails the attempt; the tool never requests a new session as a fallback.

### Configuration

Add overrides for row `requirements` to the profile patch. All fields are optional.

```yaml
- id: requirements
  config:
    agents:
      codex: codex
      codex-session: requirements-codex
      opencode: opencode
      opencode-session: requirements-opencode
      pi: requirements-pi
      pi-session: requirements-pi-session
    defaultListLimit: 20
    maxListLimit: 200
    busyTimeoutMs: 5000
    dispatchTimeoutMs: 1800000
    codex:
      command: codex
      maxOutputBytes: 8388608
      graceMs: 3000
    piSession:
      command: pi
    opencode:
      command: opencode
    pi:
      command: pi
      args: []
      maxOutputBytes: 1048576
      graceMs: 3000
```

`databasePath` defaults to `<DSH_HOME>/requirements/requirements.db`; an explicit path expands `~` and resolves relative to the host launch directory. A custom `agents` dictionary replaces the complete routing map. Pi also accepts an explicit `env` dictionary layered over the subprocess provider's credential-scrubbed environment; avoid committing credentials. Positive integer limits are validated at plugin load, and `defaultListLimit` cannot exceed `maxListLimit`. Dispatch inherits the calling Agent's effective working directory. The plugin owns the activation and cancels it on tool cancellation, its own deadline, or plugin unload.

## Understand the implementation

<details>
<summary>Implementation internals</summary>

[`cordis.patch.yml`](cordis.patch.yml) installs the service and seven tools. [`src/native-session.ts`](src/native-session.ts) runs the persistent routes using the native CLI. Codex runs with workspace write access and no interactive approvals. Pi uses JSON mode; OpenCode uses a standalone server. All three confirm the returned session ID. Other routes use `ctx.subagents`. [`src/store.ts`](src/store.ts) stores dispatch attempts and allows at most one active attempt per requirement across connections. Edits and dispatches require the last observed content revision.

[`src/pi.ts`](src/pi.ts) implements a one-shot provider through the DSH subprocess service using Pi `--print --no-session`, with the requirement delivered on stdin. It requires exit code zero, nonempty output, and complete output capture. Disposal terminates and joins the managed process tree. Plugin unload cancels and joins accepted dispatches before closing SQLite. All registrations belong to Cordis effects. No standalone application executable or separate agent loop is introduced.

</details>

## Further Exploration

- [Provider configuration overlay](examples/providers.patch.yml)
- [Requirement and assignment types](src/types.ts)
- [Dispatch decision record](../.agents/notes/implemented/architecture/2026-11-04-requirement-dispatch.md)
- [OpenCode CLI and ACP](https://opencode.ai/docs/cli/) · [Pi CLI integration](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli-integration.md)

## Model Experience

The model can call `requirement_resume` with an earlier dispatch ID to send feedback to its saved thread. The tool returns a new attempt with `resumedFrom` and, when available, `session`. DSH logs the tool result before the next request. The delegated agent receives the current requirement snapshot and the feedback.

## Known Limitations and Deferred Work

Each dispatch or follow-up runs in the foreground. Use `codex-session`, `pi-session`, or `opencode-session` for resumable execution. `pi-session` uses `piSession` configuration independently of the one-shot `pi` route. One-shot providers and earlier dispatches without a saved thread have no resumable session. Multiple requirements sent to one workspace can edit the same files. A completed agent run still needs user acceptance.

After a host crash, a persisted running attempt has an unknown external outcome and remains reserved; automatic recovery and a verified operator release command are not implemented. Do not edit SQLite or retry until the external work has been inspected. Unsupported database formats fail to open rather than migrate. Search is literal substring matching with SQLite's ASCII case folding; projects are exact labels. History stores assignment outcomes, not every intermediate requirement edit.

### Dev Note

The local tests cover saved-thread identity, working-directory reuse, and rejection of a different thread. Native Codex and OpenCode smoke tests verified that a fresh process recalled first-turn context. A native Pi smoke test verified restored context in a second model request against a local test endpoint. The keyless transcript snapshot covers logged requirement reads, edits, and routing discovery.
