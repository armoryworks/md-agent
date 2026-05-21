# md-agent

A small CLI that runs a **team of [Claude Code](https://claude.com/claude-code)
agents** against a single goal. One *orchestrator* agent coordinates several
named *role* agents (e.g. `backend-engineer`, `qa-lead`, `discovery-analyst`),
routing work to them and synthesizing what comes back. Coordination happens over
plain files on disk, so a run is fully inspectable and resumable.

> Each agent is a real `claude` process. md-agent is the conductor, not the model
> — it spawns the CLI, routes messages, persists sessions, and keeps a running
> transcript and cost tally.

## How it works

```
                 ┌──────────────────┐
   you  ──────▶  │   orchestrator   │   (a claude session; routes TO: blocks)
                 └────────┬─────────┘
              inbox/*.txt │ ▲ outbox/*.txt
                          ▼ │
        ┌───────────┬───────────┬───────────┐
        │  role A   │  role B   │  role C    │   (one claude child process each)
        └───────────┴───────────┴───────────┘
```

- The **orchestrator** replies only in `TO: <role>` blocks. Each block is written
  to that role's `inbox/<role>.txt`.
- Each **role** is a child process watching its inbox. It runs its own `claude`
  session and writes the reply to `outbox/<role>.txt`.
- The orchestrator watches every outbox, feeds replies back into its own session,
  and decides what to dispatch next.
- Every message is appended to a single `transcript.md` (the orchestrator is the
  sole writer, so the transcript is the one source of truth).
- On a timer, the run **checkpoints**: the orchestrator produces a synopsis and
  hands control back to you for feedback, interval changes, or exit.

Each participant's `claude` session id is persisted under `sessions/`, so a run
can be paused and resumed without losing context.

## Requirements

- **Node.js** ≥ 20 (ESM, `NodeNext`).
- The **`claude` CLI** installed and on your `PATH`, already authenticated.
  md-agent shells out to it (`claude -p --output-format stream-json`).

## Install & build

```bash
npm install
npm run build     # tsc → dist/
```

## Usage

Start a new run (interactive setup wizard — number of roles, each role's
description, the goal, and the checkpoint interval):

```bash
npm run dev                      # via tsx, no build step
# or, after `npm run build`:
node dist/index.js
```

Seed the run with a context document (you'll be prompted to select sections or
code blocks from it):

```bash
npm run dev -- --context ./brief.md
```

Resume a previous run:

```bash
npm run dev -- --resume runs/2026-05-21_00-28-34-my-run
npm run dev -- --resume runs/<dir> --minutes 15    # also change the checkpoint cadence
```

During a run you can type a line at any time to interject (it goes to the
orchestrator, which decides how to propagate it). At a checkpoint you can:

| Input        | Effect                                                |
|--------------|-------------------------------------------------------|
| *(text)*     | feedback to the orchestrator, then continue           |
| *(empty)*    | continue with no feedback                             |
| `extend N`   | run N more minutes before the **next** checkpoint only|
| `interval N` | change the recurring checkpoint interval to N minutes |
| `exit`       | stop the run cleanly                                  |

## Configuration (environment variables)

| Variable                  | Default      | Purpose |
|---------------------------|--------------|---------|
| `MD_AGENT_COMPACT_TOKENS` | `120000`     | When the orchestrator's context (input + cache tokens) grows past this, it is **compacted** at the next checkpoint — rolled into a fresh session seeded with the latest synopsis + condensed recent coordination. Caps context growth (the dominant cost on long runs). Set `0` to disable. |
| `MD_AGENT_ORCH_MODEL`     | *(CLI default)* | Pin the orchestrator's model — a tier (`opus`/`sonnet`/`haiku`) or a concrete model id. The orchestrator is the highest-context seat; set `sonnet` to trade some judgment for lower burn. |
| `MD_AGENT_NO_DASHBOARD`   | unset        | Disable the sticky top-of-console status panel (also auto-disabled when stdout isn't a TTY). |
| `NO_COLOR`                | unset        | Disable ANSI color in the dashboard. |

Per-role models are chosen automatically by the orchestrator at setup (each role
is assigned `opus`/`sonnet`/`haiku` by cognitive load). The concrete model ids
per tier live in `src/persist.ts` (`MODEL_IDS`).

## Cost tracking

Token usage and USD cost are captured from each `claude` turn and accumulated per
participant in `sessions/<who>.cost.json`. The run-wide total is shown live in the
dashboard header, and each role logs its per-turn and cumulative cost to the
console.

## Run layout

```
runs/<timestamp>-<name>/
├── state.json          # goal, roles, models, checkpoint interval
├── transcript.md       # full conversation (orchestrator is sole writer)
├── inbox/<role>.txt     # orchestrator → role
├── outbox/<role>.txt    # role → orchestrator
└── sessions/
    ├── <who>.txt        # persisted claude session id (for resume)
    └── <who>.cost.json  # accumulated token usage + cost
```

> **`runs/` is gitignored.** Transcripts capture full agent conversations and can
> contain credentials, secrets, and project-internal findings — never publish
> them.

## Project layout

| File                   | Responsibility |
|------------------------|----------------|
| `src/index.ts`         | CLI entry / arg parsing |
| `src/orchestrator.ts`  | setup wizard, run loop, dispatch, checkpoints, compaction |
| `src/role.ts`          | role child-process loop |
| `src/claude.ts`        | `claude` session wrapper (spawn, session-id, usage capture) |
| `src/ipc.ts`           | file-based inbox/outbox + transcript helpers |
| `src/persist.ts`       | run state, session ids, cost accounting, transcript replay |
| `src/dashboard.ts`     | sticky terminal status panel |
| `src/parse.ts` / `src/select.ts` | context-file parsing + section selection |

## License

[Apache License 2.0](LICENSE) — © 2026 ArmoryWorks. See `NOTICE`.
