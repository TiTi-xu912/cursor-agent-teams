# Architecture

## Components

```text
Cursor chat / command
        │
        ▼
Plugin Skill + Rule ──────── Cursor native Subagent templates
        │
        ▼
MCP stdio server
        │
        ├── TeamService ─── state machine / quality contracts
        ├── Scheduler ───── ready-task selection / dependency checks
        ├── FileStateStore  atomic JSON + JSONL mailbox/event log
        ├── CursorRuntime ─ @cursor/sdk Agent create/resume/send/cancel
        └── Dashboard ───── read-only HTTP projection
```

## State transitions

Team:

```text
draft ──approve──▶ running ──all complete──▶ completed ──archive──▶ archived
                     │  ▲
                   halt resume
                     ▼  │
                    halted
```

Task:

```text
pending ─▶ in_progress ─▶ completed
              │
              ├──────────▶ failed
              └──────────▶ cancelled
```

Every execution gets an incrementing attempt number and unique attempt ID.
Completion is accepted only when the submitted attempt ID is still current.
Reassignment cancels the current attempt before returning the task to pending.

## Scheduling

1. Select pending tasks whose dependencies are all completed.
2. Match explicitly assigned tasks to an idle assignee; otherwise select the
   first idle member.
3. Atomically claim task and member.
4. Run all selected read-only members concurrently.
5. Serialize write members through a process-local writer lock.
6. Persist terminal result, release member and schedule the next frontier.

Failed or cancelled dependencies never unlock downstream tasks. If only blocked
tasks remain, the team becomes halted.

## Recovery

The Cursor SDK persists Agent IDs. Member records retain those IDs and resume
the same conversations on later tasks.

After an MCP process crash, `agent_teams_recover`:

1. Marks in-flight attempts failed with a recovery reason.
2. Returns their tasks to pending without changing completed work.
3. Releases running members.
4. Restarts scheduling with a fresh attempt ID.

Inline MCP/custom tools are reconstructed on each SDK resume because the SDK
does not persist them.

## Quality gates

Quality tasks carry explicit contracts. Result validation rejects incomplete
acceptance evidence, missing review verdicts, non-pass review without findings,
and implementation changes outside `inScope`.

A failed review creates:

```text
previous implementation ─▶ repair ─▶ re-review
```

The repair does not depend on the failed review terminal node. Repair loops are
bounded by `CURSOR_AGENT_TEAMS_MAX_REPAIR_ROUNDS`.

## Trust boundaries

- Cursor/MCP tool approval remains the user-facing authorization boundary.
- Tool allow/deny lists reduce model capability but are not a sandbox.
- The state store coordinates one Node process only.
- Dashboard endpoints are read-only and bind localhost by default.
- SDK credentials are managed by Cursor auth or environment variables; they
  are never written into team state.
