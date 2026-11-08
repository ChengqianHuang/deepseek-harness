# Agent Note: Versioned requirements dispatched through DSH providers

Status: implemented

English | [中文](2026-11-04-requirement-dispatch.zh.md)

## Problem

Users need to retain requirements independently of one conversation and assign implementation to different coding agents. A mutable task description alone cannot identify what an external agent implemented or distinguish execution completion from user acceptance.

## Decision

The independent bundle stores requirements and assignment attempts in SQLite. Each edit increments the content revision; dispatch atomically claims the exact revision and permits at most one active attempt per requirement across connections. The delegated prompt contains a complete snapshot. Agent completion updates the assignment outcome while requirement acceptance remains an explicit user action.

One-shot execution uses the DSH subagent registry. Persistent routes use the native Codex, Pi, and OpenCode CLIs over managed subprocesses. Their saved sessions can outlive the Requirements plugin. SQLite binds the confirmed native thread ID and working directory to the dispatch attempt. Follow-ups must name a prior dispatch on the same requirement; the caller cannot select an unrelated native thread directly. Plugin unload cancels and joins dispatches before SQLite closes.

## Alternatives considered

**Resume the most recent native session.** Other work can share the account and workspace. Using the saved exact thread ID preserves ownership even when a later dispatch ran in the same directory. A missing or different thread fails instead of opening a substitute.

**Mark requirements done when execution ends.** An agent's final response does not establish user acceptance. Separate assignment and requirement states preserve that distinction and allow implementation review.

**Automatically retry persisted running attempts.** After host failure the external process may still own work or may have committed changes. Retaining the reservation avoids duplicate execution; operator recovery requires a future explicit protocol.

## Consequences

Additional installed providers can serve one-shot routes. The Codex resume path needs access to the same native account, session storage, and working directory. Dispatch history without a saved thread remains readable and cannot resume. Keyless tests check the original directory and thread identity, and native Codex and OpenCode smoke tests verify first-turn context in a fresh CLI process.
