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
- On a timer, the run **checkpoints**: it writes the current ledger to the
  transcript (a durable footprint) and hands control back for feedback, interval
  changes, or exit. If no one responds within a grace window it auto-continues
  and arms the next checkpoint, so the cadence stays a reliable heartbeat instead
  of stalling.

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
description, the goal, the checkpoint interval, whether to allow sub-teams, and
an optional soft time budget):

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
npm run dev -- --resume runs/2026-05-21_00-28-34-my-run         # prompts for the checkpoint interval (defaults to the run's stored value)
npm run dev -- --resume runs/<dir> --minutes 15                 # skip the prompt; set it directly (also --minutes=15)
```

On resume you're asked for the checkpoint interval (pre-filled with the run's
stored value); passing `--minutes` skips the prompt. Either way the choice is
persisted to `state.json`.

Launch a run from a config file instead of the wizard (the console UI still
runs — this only replaces the setup questions):

```bash
npm run dev -- --launch ./my-run.json
```

The config is a `LaunchConfig` (see `src/persist.ts`): `goal`, `roles`
(`{name?, description, model?}`), and optional `name`, `context` (path to a doc
included whole), `inbox` (path to a handshake doc prepended as context),
`maxMinutes`, `teams`, `budgetMinutes`, `autoComplete`, `kickoff`, `runDir`.
Anything omitted (run name, per-role name/model) is filled by the one-time
bootstrap turn; supply them all and that LLM call is **skipped**, so the run
starts instantly.

`autoComplete` lets the orchestrator **end the run itself** — once the goal is
met, every role is idle, and all work is committed it emits `[[PHASE-COMPLETE]]`
and the run tears down cleanly instead of idling until the budget/a checkpoint.
Off by default for the interactive wizard (the run stays alive for more work);
journey phases default it **on** so a finished phase advances the journey
without a human typing `exit`.

### Journeys (templated multi-phase runs)

Define an entire campaign up front and let each phase hand off to the next:

```bash
npm run dev -- --journey ./journey.json
```

A `journey.json` is `{ "name": "...", "phases": [ ... ] }` where each phase is a
launch config plus an `id` and optional `pauseBefore`. Phases run **in sequence,
each as its own child orchestrator** (full console UI, independently resumable).
When a phase finishes, md-agent reads that phase's ledger and authors a **parting
handshake** — what it produced, surprises, and suggested role adjustments — into
the next phase's folder (`phases/<id>/INBOX.md`), which that phase reads as
context on launch. A handshake may target **multiple downstream phases** when the
outcome materially changes a later one. Before each non-first phase (unless
`pauseBefore: false`) the driver pauses so you can read the handshake and edit the
manifest live, then `Enter` to launch, `skip`, or `exit`. A worked example lives
in `E:/dev/forge-journey/`.

### Time budget (scoping)

Setup and resume also ask for an optional **soft time budget** (minutes). When
set, every orchestrator turn is prefixed with a live `⏱` line — elapsed and
remaining — and the orchestrator is instructed (system prompt) to scope work to
fit: prefer landing small, committable units over starting work it can't finish,
and **wind down** as the budget nears. The budget is **soft** — once exceeded the
signal flips to "wind down, start nothing new," but the run does **not** hard-stop;
over-runs are tolerated to land in-flight work. The budget is per-session (resets
on resume — "give it a 15-minute run"). Blank = no budget (the `⏱` line then shows
elapsed only).

During a run you can type a line at any time to interject (it goes to the
orchestrator, which decides how to propagate it). At a checkpoint you can:

| Input        | Effect                                                |
|--------------|-------------------------------------------------------|
| *(text)*     | feedback to the orchestrator, then continue           |
| *(empty)*    | continue with no feedback                             |
| *(no input)* | after the grace window, auto-continues (heartbeat stays alive) |
| `extend N`   | run N more minutes before the **next** checkpoint only|
| `interval N` | change the recurring checkpoint interval to N minutes |
| `exit`       | stop the run cleanly                                  |

## Configuration (environment variables)

| Variable                  | Default      | Purpose |
|---------------------------|--------------|---------|
| `MD_AGENT_ORCH_MODEL`     | *(CLI default)* | Pin the orchestrator's model — a tier (`opus`/`sonnet`/`haiku`) or a concrete model id. Set `sonnet` to trade some judgment for lower burn. |
| `MD_AGENT_HANDSHAKE_MODEL`| *(orch model, then CLI default)* | Model for the short between-phase handshake turn in a `--journey` run. Falls back to `MD_AGENT_ORCH_MODEL`, then the CLI default. |
| `MD_AGENT_CHECKPOINT_GRACE`| `120`        | Seconds a checkpoint waits for your input before auto-continuing and arming the next one. `0` = wait indefinitely (block until you respond — the old behavior). |
| `MD_AGENT_HEARTBEAT_STALL` | `360`        | Seconds a role's claude turn may produce **no stream output** before the watchdog treats it as hung and re-spawns it (resuming its session) + re-issues the work. The session beats a heartbeat on every output chunk, so a busy turn stays fresh; only a genuinely stuck turn (e.g. a tool call that never returns) goes silent this long. A dead (crashed) role is recovered immediately via its exit event regardless. |
| `MD_AGENT_TEAMS`          | off          | Pre-sets the **"allow sub-teams?"** setup-wizard prompt to "yes". Sub-teams are opt-in **per run** — the wizard asks at setup and the choice is stored in `state.json`. When allowed, the orchestrator may send two roles into a 1:1 **huddle** (`TEAM: <name> members=a,b`): they iterate directly and only one consolidated result returns to the orchestrator — the back-and-forth never enters its context. |
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
