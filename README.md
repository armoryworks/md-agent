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

- The **orchestrator** is **stateless**: it has no growing conversation. Each turn
  it is handed its **ledger** (`ledger.md` — its externalized memory) plus one new
  event, and it replies with an updated ledger + zero or more `TO: <role>` blocks.
  Each block is written to that role's `inbox/<role>.txt`.
- Each **role** is a child process watching its inbox. It runs its own (stateful)
  `claude` session and writes the reply to `outbox/<role>.txt`.
- The orchestrator watches every outbox; each reply becomes the next event it
  folds into the ledger and acts on.
- Every message is appended to a single `transcript.md` (the orchestrator is the
  sole writer, so the transcript is the one source of truth).
- On a timer, the run **checkpoints**: it shows you the current ledger and hands
  control back for feedback, interval changes, or exit.

**Why the ledger?** Feeding every role reply into a growing orchestrator
conversation makes per-turn cost climb with the run — and worse, when a child
agent takes minutes to reply, the orchestrator's prompt cache expires, so the
*entire* growing context is re-read at full price on the next turn. Keeping the
orchestrator's resident context to `system + ledger + this event` makes it
**bounded by design**: a cold cache is cheap because there's little to re-read.
The ledger holds status and pointers; details live in shared files and are
retrieved only when needed.

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
| `MD_AGENT_ORCH_MODEL`     | *(CLI default)* | Pin the orchestrator's model — a tier (`opus`/`sonnet`/`haiku`) or a concrete model id. Set `sonnet` to trade some judgment for lower burn. |
| `MD_AGENT_TEAMS`          | off          | Opt-in **sub-teams**. When `1`/`true`/`on`, the orchestrator may send two roles into a 1:1 **huddle** (`TEAM: <name> members=a,b`): they iterate directly and only one consolidated result returns to the orchestrator — the back-and-forth never enters its context. Off by default. |
| `MD_AGENT_TEAM_MAX_ROUNDS`| `12`         | Hard cap on huddle exchanges before the reporter is forced to summarize (runaway-loop backstop). Per-team override via `maxRounds=` in the `TEAM:` block. |
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
├── ledger.md           # orchestrator's memory (stateless across turns; resume reads this)
├── transcript.md       # full conversation (orchestrator is sole writer)
├── inbox/<role>.txt     # orchestrator → role
├── outbox/<role>.txt    # role → orchestrator
├── teams/<name>/channel.md  # huddle transcript (only when sub-teams are used)
└── sessions/
    ├── <who>.txt        # persisted claude session id — roles only (orchestrator is stateless)
    └── <who>.cost.json  # accumulated token usage + cost
```

> **`runs/` is gitignored.** Transcripts capture full agent conversations and can
> contain credentials, secrets, and project-internal findings — never publish
> them.

## Project layout

| File                   | Responsibility |
|------------------------|----------------|
| `src/index.ts`         | CLI entry / arg parsing |
| `src/orchestrator.ts`  | setup wizard, run loop, ledger turns, dispatch, checkpoints |
| `src/team.ts`          | sub-team engine (1:1 huddle) — opt-in via `MD_AGENT_TEAMS` |
| `src/role.ts`          | role child-process loop |
| `src/claude.ts`        | `claude` session wrapper (spawn, session-id, usage capture) |
| `src/ipc.ts`           | file-based inbox/outbox + transcript helpers |
| `src/persist.ts`       | run state, session ids, cost accounting, transcript replay |
| `src/dashboard.ts`     | sticky terminal status panel |
| `src/parse.ts` / `src/select.ts` | context-file parsing + section selection |

## License

[Apache License 2.0](LICENSE) — © 2026 ArmoryWorks. See `NOTICE`.
