---
name: agent-teams
description: Coordinates persistent multi-agent delivery with role-specific Cursor agents, dependency-aware tasks, durable messaging, quality gates and automatic scheduling. Use when the user invokes /agent-teams, requests a team of agents, asks for parallel implementation and review, or continues an existing Cursor Agent Team.
---

# Cursor Agent Teams

Use the `agent_teams_*` MCP tools. Persisted MCP state is authoritative.

## Start or continue

1. Call `agent_teams_list`.
2. If the user refers to an active team, call `agent_teams_status` and continue it.
3. Otherwise inspect the repository enough to design a small roster and task DAG.
4. Call `agent_teams_create`; retain the returned team ID.
5. Add members with `agent_teams_add_member`.
6. Create tasks in dependency order with `agent_teams_create_task`.
7. Show the draft to the user, then call `agent_teams_approve`.

Do not create a second active team for the same goal.

## Roster defaults

Use only roles justified by the work:

- Planner/analyst: `readonly: true`
- Implementer: `readonly: false`
- Verifier: `readonly: true`
- Reviewer: `readonly: true`

Prefer `model: "auto"` unless the user names a model. Use tool allow/deny lists
only when the task requires tighter controls.

## Task graph

- Parallel tasks have no dependency edge between them.
- A task may depend only on IDs already returned by task creation.
- Assign write tasks to implementers and review tasks to independent reviewers.
- Avoid concurrent write tasks that touch overlapping paths.

For ordinary tasks, use `kind: "work"`.

For quality-gated delivery:

1. `requirements`
2. `implementation`
3. `verification`
4. `review`
5. `integration`

All quality tasks require `objective` and `acceptance`.
Implementation and repair additionally require `in_scope` and `verify`.

## Monitoring and intervention

- Use `agent_teams_status` for progress and terminal results.
- Use `agent_teams_send_message` for durable guidance.
- Use `agent_teams_reassign_task` when ownership must change.
- After an interrupted MCP process, call `agent_teams_recover`.
- Stop with `agent_teams_halt`; resume with `agent_teams_resume` and a reason.
- Call `agent_teams_dashboard` when a visual status view helps.

## Completion

Summarize results from completed task records, including verification evidence
and unresolved findings. When the team is terminal, archive it with
`agent_teams_archive` if the user no longer needs it active.
