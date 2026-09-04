# md-agent

A small CLI that runs a **team of agent CLIs** — [Claude Code](https://claude.com/claude-code)
and, per seat, [Antigravity](https://antigravity.google) — against a single goal.
One *orchestrator* agent coordinates several named *role* agents (e.g.
`backend-engineer`, `qa-lead`, `discovery-analyst`), routing work to them and
synthesizing what comes back. Coordination happens over plain files on disk, so
a run is fully inspectable and resumable.

The shape it is built for: **delegate** mechanical work to a cheap seat,
**isolate** every seat in its own git worktree, **verify** each worktree with a
command that proves the result, **admit** the branches that pass. Judgement
stays on a claude seat; nothing lands in your tree until you merge it.

> Each agent is a real `claude` or `agy` process. md-agent is the conductor, not
> the model — it spawns the CLI, routes messages, persists sessions, tees every
> seat's stream to a trace, and keeps a running transcript and cost tally.

## How it works

```
                 ┌──────────────────┐
   you  ──────▶  │   orchestrator   │   (a claude session; routes TO: blocks)
                 └────────┬─────────┘
              inbox/*.txt │ ▲ outbox/*.txt
                          ▼ │
        ┌───────────┬───────────┬───────────┐
        │  role A   │  role B   │  role C    │   (one agent CLI process each — claude or agy)
        └───────────┴───────────┴───────────┘
```

- The **orchestrator** is **stateless**: it has no growing conversation. Each turn
  it is handed its **ledger** (`ledger.md` — its externalized memory) plus the new
  event(s), and it replies with an updated ledger + zero or more `TO: <role>` blocks.
  Each block is written to that role's `inbox/<role>.txt`. Events that arrive while
  a turn is in flight (e.g. several roles finishing at once) are **coalesced into a
  single next turn** — one ledger in, one ledger out — instead of paying a full
  turn per event; the orchestrator also plans against the joint state rather than
  arrival order. Multiple `TO:` blocks for the same role merge into one message,
  and an unconsumed inbox is appended to, never overwritten, so dispatches can't
  be silently lost.
- Each **role** is a child process watching its inbox. It runs its own (stateful)
  `claude` or `agy` session and writes the reply to `outbox/<role>.txt`.
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

Each participant's session id is persisted under `sessions/`, so a run can be
paused and resumed without losing context.

## Requirements

- **Node.js** ≥ 20 (ESM, `NodeNext`).
- The **`claude` CLI** installed and on your `PATH`, already authenticated.
  md-agent shells out to it (`claude -p --output-format stream-json`). The
  orchestrator is always claude.
- Optionally the **`agy` CLI** (Antigravity), for seats configured with
  `provider: "agy"` (`agy -p --output-format stream-json`). Only the providers a
  run is configured to use are probed at launch.
- **git**, when a run uses `isolation: "worktree"`.

## Install & build

```bash
npm install
npm run build     # tsc → dist/
```

## Usage

Just run it:

```bash
md-agent                         # after: npm install -g @armoryworks/md-agent
npx @armoryworks/md-agent        # or without installing
npm run dev                      # from a checkout, via tsx
```

A bare `md-agent` opens the **home screen**: it scans `./runs` for prior work
and presents it — standalone runs and journeys (grouped with their phases),
each with its goal, spend, recency and status (`running`, `unfinished`,
`HALTED`, `complete`). Nothing on it asks you to touch the filesystem:

- **Continue** — the first choice, always the most recent unfinished thing. A
  run resumes where it stopped (seats reattach to their sessions). A journey is
  driven from its first phase that did not end cleanly: a halted phase is
  retried in place (its `HALT.txt` is cleared and the reason kept in the
  transcript), an unfinished one resumed, the next one started. The manifest
  path is recorded in each phase run, so nothing has to be re-typed.
- **Launch `md-agent.launch.json`** — offered when the current directory has
  one (see `md-agent init` below).
- **Resume a specific run or phase** — choose exactly which one.
- **Look inside a seat** — a seat's trace: what it was asked, the tools it ran,
  what it said, what each turn cost. See *Looking inside a seat*.
- **Start something new** — the setup wizard (roles, goal, checkpoint interval,
  sub-teams, soft time budget).
- **Combine past runs into a new run** — select one or more prior runs; a new
  run is seeded with their goals + final ledgers + pointers to their artifacts,
  and the wizard takes it from there.
- **Mark runs complete** / **Restore a shelved run** — shelve finished work
  (hidden from the menus, untouched on disk) and bring it back later.

### The wizard: goal first, then a fork

*Start something new* asks, in this order:

1. **What should the orchestrator be reaching for?** — the goal. It is the
   first question because it is what everything else is sized to.
2. **Journals** — keep this project's run records in a private repo? Use the
   configured one, pick or create another, skip for this run only, or *No, and
   don't ask again — ever*. Once opted out the panel's footer shows
   `journals off (type "journals")`; that keyword, typed during any run, turns
   them back on.
3. **How should the team be set up?** — *Have Claude plan it* or *Set it up by
   hand*. The planner (`MD_AGENT_PLANNER_MODEL`, default `claude-fable-5-1`)
   is given the goal, a read-only look at the repo, and a brief on how md-agent
   works, and returns a recommended team: how many seats, each one's mandate,
   provider and tier, the verify command it found, isolation, escalation, a
   budget, and the questions it could not settle. Then: **launch it**, **save
   it** as `md-agent.launch.json` to edit and launch from the home screen, or
   **adjust it by hand** (the wizard, prefilled). A plan costs roughly a
   dollar's worth of tokens and takes under a minute.

### `md-agent init`

Writes a starter `md-agent.launch.json` into the current repo — a cheap seat
behind a verify command, a claude reviewer, worktree isolation, escalation, an
inline `$help` block explaining each choice. Edit the goal and `verify.cmd`,
then `md-agent` offers it as a one-key launch (or `md-agent --launch
md-agent.launch.json`). The second run never needs the wizard.

### The umbrella

While a run is live the top of the console is frozen — the ArmoryWorks mark,
the run's **goal**, and a tree of the orchestrator with every seat beneath it:
provider and model, what it is doing and for how long (`working 38s`,
`replied 2m ago`, `in huddle`, `recovering`), turns taken, last-turn cost and
cache read, cumulative spend. Log output scrolls underneath. It is a status
surface only: seats still report to the orchestrator through their outboxes
exactly as before.

### Stopping a seat

**ctrl-x** at any time (or type `stop`) opens the stop menu: pick one or more
seats, then for each choose **hand off to <seat>** or **leave abandoned**. A
handoff gives the receiving seat the stopped seat's mandate, its outstanding
dispatch (or the last one it was working on), its last report, and — under
worktree isolation — where its edits live, so nothing has to be re-explained.
Either way the stopped seat's outbox carries a `[SEAT STOPPED]` note naming
who picked the work up (or that nobody did), which reaches the orchestrator
through the normal path, so it re-plans instead of waiting on a seat that is
gone. A stopped seat stays stopped across resumes; dispatches to it are
dropped and reported back.

### Verify where the work is

With a `verify` command set, **every seat reply is checked in that seat's own
workspace** before the orchestrator sees it. A reply that claims to be done
while the check fails is sent straight back to the seat with the output — no
orchestrator turn is spent relaying it — up to `maxFailures` times; after that
(or for replies that are not completion claims) the result is attached to the
reply the orchestrator receives. The completion gate runs the same way: under
isolation, every seat whose workspace changed must pass. The orchestrator
itself runs without edit tools (`Write`, `Edit`, `Bash`…) so it coordinates
rather than doing the work — `MD_AGENT_ORCH_TOOLS=all` restores them.

### Budgets

`budget` in a launch config (or journey phase) sets spend ceilings, each with a
**soft** line (the orchestrator is told to wind down) and a **hard** line (the
run HALTs cleanly and can be continued from the home screen once it clears):

```json
"budget": {
  "usd":         { "soft": 5,  "hard": 10 },
  "tokens":      { "soft": 2000000 },
  "fiveHourPct": { "soft": 70, "hard": 90 },
  "sevenDayPct": { "hard": 95 }
}
```

`usd` and `tokens` sum every seat and the orchestrator (tokens = everything
processed: input, cache reads and writes, output). `fiveHourPct` and
`sevenDayPct` are your **plan windows** — the claude CLI reports them on every
turn, so they are exact and need no translation from your usage page; agy seats
don't report them, so for agy-heavy runs use `tokens`. The umbrella shows all
of it live: per-turn and net spend for each seat and the orchestrator, the run
total, and `5h 21% · 7d 7%`.

### Journals — a run's record in source control

A run's **journal** is its durable record: `state.json` (goal, seats, context,
budget, journey reference, end stamp), `ledger.md`, `transcript.md`,
`context.md`, `log/` (the seat traces), spend files, the mailboxes, and a
generated `JOURNAL.md` cover page. Not the seats' worktrees — those are
branches in the project repo already. The repo root carries a **master index**,
regenerated on every push: `index.json` for md-agent and `JOURNALS.md` for
people — every run across every project with status, spend and goal, linked
to its cover page — so one pull tells the home screen what the repo holds.

`./runs/` stays the working store and the journal is a filtered copy of it,
rather than the run directory being a checkout: the seats' git worktrees live
under the run directory, and a live run writes every turn.

Journals never go into the project repo (`runs/` is gitignored there on
purpose: transcripts and traces carry credentials and internal findings).
They go to a **private journal repository per project** — `forge-md-agent`,
`nom-md-agent` — or one shared fallback, configured in
`~/.config/md-agent/config.json`:

```json
{ "journal": { "repos": { "forge": "git@github.com:armoryworks/forge-md-agent.git" },
               "remote": "git@github.com:armoryworks/md-agent-journals.git",
               "ask": true, "autoPush": false } }
```

- **At the end of every run** — clean, **interrupted** (ctrl-c), or halted —
  md-agent asks whether to push the journal. A project with no repo yet is
  offered `<owner>/<project>-md-agent`, created private with `gh`; or a URL
  of your own; or the shared repo. Every one of these prompts has **"No, and
  don't ask again — ever"**, remembered globally; pushing stays available from
  the home screen. "Yes, and always push" turns on `autoPush`.
- **Before every push** the remote's visibility is checked (`gh repo view`):
  a **public** repo is refused outright, an internal or unverifiable one needs
  an explicit yes. The journal is also scanned for credential shapes (API
  keys, tokens, private-key blocks) and a hit blocks the push until confirmed.
- **Home screen → ⇅ Journals**: push runs not yet pushed, pull journals from
  the repo into `./runs` (they then appear on the home screen — *Continue*,
  *Look inside a seat*, *Combine* all work on them), change the project's repo,
  or set the run-end prompt to ask / auto-push / never.

A pulled run's seats can't reattach to sessions from another machine; on
*Continue* they are re-seeded from the transcript, which is the same fallback
a local run uses when its session is gone.

### Looking inside a seat

Every participant's turns are teed verbatim to `runs/<dir>/log/<seat>.jsonl`
— the orchestrator included — bracketed by md-agent turn markers carrying the
prompt excerpt, model, duration and usage. The outbox is a seat's status
report; the log is its working. Read it three ways:

- **During a run:** type `show <seat>` (a name, its number, or `orch`) at the
  console — the panel steps aside for a pager and comes back when it closes.
  `show` alone lists the seats.
- **From the home screen:** *Look inside a seat*.
- **From the shell:** `md-agent --inspect runs/<dir> --seat <name>`.

The rendering collapses tool calls to one line each (`⚙ Bash npm test`),
shows the head of each result, surfaces permission denials (`⛔ denied Write …`)
and drops the CLI's bookkeeping events.

Everything below remains available as flags for scripting and automation.

Seed the run with a context document (you'll be prompted to select sections or
code blocks from it):

```bash
npm run dev -- --context ./brief.md
```

Resume a previous run:

```bash
npm run dev -- --resume runs/2026-05-21_00-28-34-my-run         # prompts for the checkpoint interval (defaults to the run's stored value)
npm run dev -- --resume runs/<dir> --minutes 15                 # skip the prompt; set it directly (also --minutes=15)
npm run dev -- --resume runs/<dir> --quiet                      # no prompts at all: stored interval + budget (what the journey driver uses)
```

Version:

```bash
md-agent --version        # also -v, or `md-agent version`
```

Stop a run that has no console (started detached, or from another terminal):

```bash
npm run dev -- --stop runs/<dir>     # places STOP in the run dir; the run tears down cleanly within seconds
touch runs/<dir>/STOP                # the same, by hand
```

The run's watchdog picks the file up, tells the seats to exit, audits the
workspaces, stamps `endedAt`, and — if a journal repo is configured with
`autoPush` — pushes the journal. `--stop` waits for that and only sends
`SIGTERM` if the process lingers past 30s. (A `HALT.txt` placed in the dir by
hand is honored the same way.)

Look inside a seat of any run:

```bash
npm run dev -- --inspect runs/<dir>                  # list the seats
npm run dev -- --inspect runs/<dir> --seat engineer  # open one's trace in a pager
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
(`{name?, description, model?, provider?, permissionMode?}`), and optional `name`, `context` (path
to a doc included whole), `inbox` (path to a handshake doc prepended as context),
`maxMinutes`, `teams`, `budgetMinutes`, `autoComplete`, `kickoff`, `runDir`,
`verify`, `escalation`, `isolation`, `budget`, `journal` (per-run override of
the journal settings: `{ remote?, autoPush?, ask? }`). Anything omitted (run name, per-role name/model) is filled
by the one-time bootstrap turn; supply them all and that LLM call is **skipped**,
so the run starts instantly.

The interactive wizard asks this per role. It prints what each backend is suited
to — claude for judgement, review and anything that can be quietly wrong; agy for
breadth, volume and mechanical work behind a verifier — then picks one seat at a
time, so the choice is made against the task's shape rather than by habit. The
config/journey path supplies `provider` directly and skips the prompt.

- **`roles[].provider`** — `"claude"` (default) or `"agy"` (Antigravity, which
  replaced the deprecated Gemini CLI). Configuration-based, no autodetection. The
  orchestrator is always `claude`. **Both providers are stateful** — claude resumes
  with `--resume`, agy with `--conversation` — so an agy seat keeps its context
  across turns and is recycled on the same schedule. Use agy seats for cheap,
  mechanical or high-volume role work. agy resolves paths against its
  *project*, not the process cwd (started bare it works in
  `~/.gemini/antigravity-cli/scratch`), so every agy turn is bound to the seat's
  directory with `--add-dir` — under worktree isolation that is the seat's
  worktree, otherwise the shared tree. The tier (`model`) maps per provider
  (claude `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5`, agy
  `gemini-3.1-pro-high` / `gemini-3.8-flash-high` / `gemini-3.8-flash-low`), or
  name a concrete id and it is passed through as-is (`gemini-3.1-pro-low`,
  `gpt-oss-120b-medium`); `agy models` lists what is available. Claude models
  through agy are a generation behind the `claude` CLI and burn Antigravity
  quota at 8× — there is no seat where they win. `permissionMode` is honored by
  both: claude passes it to `--permission-mode`, agy maps it onto
  `--mode accept-edits` / `--mode plan` / `--dangerously-skip-permissions`.
- **`isolation`** — `"none"` (default) or `"worktree"`, asked by the wizard.

  With `"none"` every seat edits md-agent's cwd directly. Simple, and fine when
  the seats are advisory or you trust the run end to end.

  With `"worktree"` each role gets its own `git worktree` at
  `<runDir>/workspaces/<role>` on branch `md-agent/<run>/<role>`, cut from the
  repo's current HEAD. Seats cannot overwrite each other, and the run's output
  becomes reviewable artifacts instead of edits already in your tree — audit with
  `git diff`, keep with a merge, discard with `git worktree remove`. That is what
  makes a cheaper provider safe to delegate to: a wrong answer is dropped, not
  reverted back out.

  On teardown the orchestrator prints each seat's directory, branch and diffstat,
  because an audit surface nobody is told about does not get audited. **When a
  `verify` command is configured it is run inside each workspace** — the same
  runner, timeout and output tail as the completion gate, only the working
  directory differs — and each seat is marked PASS or FAIL with the failing
  output. That is the difference between "here are some branches" and "here is
  which branch is safe to merge": admission becomes informed rather than hopeful. If the
  target is not a git repo this fails loudly rather than falling back to the
  shared tree — a silent fallback would leave you believing edits were contained
  when they were not. `roles[].cwd` overrides it per seat.

- **`roles[].escalate`** — default `true`. Set `false` to pin a seat at its tier
  so the escalation ladder cannot promote it. A deliberately cheap seat doing
  bulk enumeration should stay cheap when a verify failure escalates the rest of
  the team; otherwise escalation quietly erases the cost split the seat was
  chosen for. If every seat is pinned, escalation logs that and does nothing.

- **`verify`** (`{cmd, cwd?, maxFailures?, timeoutSec?}`) — deterministic completion
  gate + circuit breaker. The orchestrator's `[[PHASE-COMPLETE]]` is honored only when
  `cmd` exits 0; a non-zero exit feeds the output back to fix, and after `maxFailures`
  (default 2) consecutive fails the run HALTs rather than looping. The LLM fixes; the
  gate decides "done".
- **`escalation`** (`ModelTier[]`, requires `verify`) — on repeated verify failure,
  climb this tier ladder (re-spawning roles on the stronger tier — resuming their
  sessions by default, with the failing verify output attached verbatim to the next
  dispatch) before the circuit breaker HALTs.
- **`roles[].permissionMode`** — claude CLI `--permission-mode` for that role's
  session (e.g. `acceptEdits`). See `MD_AGENT_ROLE_PERMISSION_MODE` below.

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
manifest live, then `Enter` to launch, `skip`, or `exit`.

**Resuming a journey:** the home screen's *Continue* does this for you. By hand,
`--from <phase-id>` starts at that phase and skips the ones before it (e.g. after
a crash, a HALT, or a partial prior run). If that phase already has a ledger and
did not end cleanly (killed, or halted by the watchdog), it is **resumed** — its
seats reattach to their sessions and the HALT marker is cleared — rather than
started over:

```bash
npm run dev -- --journey ./journey.json --from 05-some-phase
```

Caveat: `--from` only inherits upstream **context** if those earlier phases
**actually ran before** — their handshakes live in `phases/<id>/INBOX.md` and
persist. Using `--from` to skip into a phase on a journey whose earlier phases never
ran means the resumed phase starts with **no upstream handshake**. (`--from` has no
effect without `--journey`.)

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
| `show <seat>`| open a seat's trace (any time, not only at a checkpoint) |
| `stop`       | stop one or more seats — hand off or abandon (also **ctrl-x** any time) |
| `exit`       | stop the run cleanly                                  |

## As a Claude Code skill

```bash
md-agent skill install            # every project on this machine → ~/.claude/skills/md-agent/
md-agent skill install --project  # this project only → ./.claude/skills/md-agent/ (commit it to share)
```

Teaches Claude Code when a task is a team job (a cheap complete check, parallel
parts, branches to review, work that outlives the session), how to write a
launch config, the console commands, and how to read a run. It is picked up at
the start of the next session, in the CLI, desktop app and IDE extensions;
`/md-agent <goal>` invokes it by name, or Claude reaches for it on its own when
a task looks team-sized. `md-agent skill uninstall` removes it, `skill show`
prints it. The skill ships in the npm package under `skills/`.

You're offered it the **first time the home screen opens** on a machine that
has Claude Code but not the skill — install user-wide, for this project, not
now, or don't ask again. (There is deliberately no install-time script: current
npm hides install-script output and flags packages that have one.)

## Configuration (environment variables)

| Variable                  | Default      | Purpose |
|---------------------------|--------------|---------|
| `MD_AGENT_ORCH_MODEL`     | `sonnet`     | The orchestrator's model — a tier (`opus`/`sonnet`/`haiku`) or a concrete model id. It re-reads a ledger and routes, so it does not inherit the CLI's default model; set `opus` when there is no `verify` and judgement is the whole job. |
| `MD_AGENT_PLANNER_MODEL`  | `claude-fable-5-1` | The model that plans a team in the wizard's *Have Claude plan it* fork — a tier or a concrete id. |
| `MD_AGENT_ORCH_TOOLS`     | unset        | `all` gives the orchestrator its edit tools back (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`). Off by default: a coordinator that can edit will do the seats' work itself. |
| `MD_AGENT_HANDSHAKE_MODEL`| *(orch model, then CLI default)* | Model for the short between-phase handshake turn in a `--journey` run. Falls back to `MD_AGENT_ORCH_MODEL`, then the CLI default. |
| `MD_AGENT_CHECKPOINT_GRACE`| `120`        | Seconds a checkpoint waits for your input before auto-continuing and arming the next one. `0` = wait indefinitely (block until you respond — the old behavior). |
| `MD_AGENT_HEARTBEAT_STALL` | `360`        | Seconds a role's claude turn may produce **no stream output** before the watchdog treats it as hung and re-spawns it (resuming its session) + re-issues the work. The session beats a heartbeat on every output chunk, so a busy turn stays fresh; only a genuinely stuck turn (e.g. a tool call that never returns) goes silent this long. A dead (crashed) role is recovered immediately via its exit event regardless. |
| `MD_AGENT_TEAMS`          | off          | Pre-sets the **"allow sub-teams?"** setup-wizard prompt to "yes". Sub-teams are opt-in **per run** — the wizard asks at setup and the choice is stored in `state.json`. When allowed, the orchestrator may send two roles into a 1:1 **huddle** (`TEAM: <name> members=a,b`): they iterate directly and only one consolidated result returns to the orchestrator — the back-and-forth never enters its context. |
| `MD_AGENT_TEAM_MAX_ROUNDS`| `12`         | Hard cap on huddle exchanges before the reporter is forced to summarize (runaway-loop backstop). Per-team override via `maxRounds=` in the `TEAM:` block. |
| `MD_AGENT_ORCH_STALL`     | `600`        | Seconds the orchestrator may sit idle with **no role work pending and no turn** before the progress watchdog nudges it (and, after `MD_AGENT_ORCH_MAX_NUDGES`, HALTs). Catches the orchestrator-side deadlock the role watchdog can't see. |
| `MD_AGENT_ORCH_HANG`      | `360`        | Seconds the orchestrator's own claude turn may produce no output before it's treated as hung mid-turn → HALT (no self-recovery, which would re-enter the stuck path). |
| `MD_AGENT_ORCH_MAX_NUDGES`| `2`          | Consecutive progress-watchdog nudges with no advance before the run HALTs. |
| `MD_AGENT_SKIP_PREFLIGHT` | unset        | Skip the launch-time agent readiness probe (P4). Set for offline / fast-iteration runs. |
| `MD_AGENT_MAX_EVENT_CHARS`| `16000`      | Choke-point (P2): a role reply longer than this is spilled to `runs/<dir>/spill/<role>-<ts>.md` and the orchestrator gets a head excerpt + pointer. `0` disables. |
| `MD_AGENT_MAX_LEDGER_CHARS`| `8000`      | Ledger size target. The ledger is re-read AND re-emitted every turn, so bloat taxes every later turn twice; past this size the next turn carries a deterministic compact-now nudge. `0` disables. |
| `MD_AGENT_ROLE_RECYCLE_TURNS` | `8`      | Role-session recycling: after N turns, a role writes a ≤300-word handoff note and is reseeded as a fresh session (mandate + handoff), bounding its ever-growing resident context (and cache-read cost per turn) on long runs. `0` disables. The per-turn `ctx ~Nk tok · cache X% hit` role log, and the live per-seat cost shown in the dashboard, are the data for tuning N. |
| `MD_AGENT_ROLE_PERMISSION_MODE` | unset  | Default `--permission-mode` for claude-backed roles (e.g. `acceptEdits`, `bypassPermissions`). Headless `-p` sessions auto-deny tools the host settings don't allow, so roles that edit files need this (or a per-role `permissionMode` in the launch config, which takes precedence) on hosts without a global allowlist. |
| `MD_AGENT_ESCALATION_FRESH` | off        | Escalation (P1c) re-spawns roles on the stronger tier **resuming their sessions** by default (they keep everything learned attempting the fix). Set to discard that context and start the upgraded team fresh instead. |
| `MD_AGENT_NO_DASHBOARD`   | unset        | Disable the sticky top-of-console status panel (also auto-disabled when stdout isn't a TTY). |
| `NO_COLOR`                | unset        | Disable ANSI color in the dashboard. |

Per-role models are chosen automatically by the orchestrator at setup when a
seat leaves `model` unset (each role is assigned `opus`/`sonnet`/`haiku` by
cognitive load); a launch config can pin a tier or a concrete id. The concrete
ids per tier live in `src/persist.ts` (`MODEL_IDS` for claude, `AGY_MODEL_IDS`
for agy).

## Cost tracking

Token usage and USD cost are captured from each `claude` turn and accumulated per
participant in `sessions/<who>.cost.json`. The run-wide total is shown live in the
dashboard header, and each role logs its per-turn and cumulative cost to the
console.

## Run layout

```
runs/<timestamp>-<name>/
├── state.json          # goal, roles, models, checkpoint interval; "endedAt"/"endReason"
│                       #   once torn down cleanly; "journey" for a phase run;
│                       #   "completedAt" when shelved (Restore clears it)
├── ledger.md           # orchestrator's memory (stateless across turns; resume reads this)
├── context.md          # large shared-context brief (only when > ~2 KB) — the orchestrator
│                       #   gets a pointer + excerpt in its prefix and reads this on demand;
│                       #   roles always carry the full brief in their instructions
├── transcript.md       # full conversation (orchestrator is sole writer)
├── log/<seat>.jsonl     # every turn's CLI stream, verbatim — the seat's working (orchestrator too)
├── inbox/<role>.txt     # orchestrator → role
├── outbox/<role>.txt    # role → orchestrator
├── teams/<name>/channel.md  # huddle transcript (only when sub-teams are used)
└── sessions/
    ├── <who>.txt        # persisted claude session id — roles only (orchestrator is stateless)
    ├── <who>.cost.json  # accumulated token usage + cost
    └── <who>.window.json # latest plan-window utilization a claude seat saw
```

> **`runs/` is gitignored.** Transcripts capture full agent conversations and can
> contain credentials, secrets, and project-internal findings — never publish
> them.

## Project layout

| File                   | Responsibility |
|------------------------|----------------|
| `src/index.ts`         | CLI entry / arg parsing (`init`, `--inspect`, …) |
| `src/home.ts`          | home screen: run discovery, continue/resume/inspect/combine/shelve menus |
| `src/init.ts`          | `md-agent init` — starter launch config |
| `src/journal.ts`       | journals: private repo per project, push/pull, visibility + secret checks, the run-end offer |
| `src/inspect.ts`       | seat traces: render `log/<seat>.jsonl`, pager |
| `src/plan.ts`          | the planner: goal + repo + design brief → recommended team |
| `src/theme.ts`         | ArmoryWorks palette, the mark, ANSI helpers |
| `src/orchestrator.ts`  | setup wizard, run loop, ledger turns, dispatch, checkpoints |
| `src/team.ts`          | sub-team engine (1:1 huddle) — opt-in via `MD_AGENT_TEAMS` |
| `src/role.ts`          | role child-process loop |
| `src/claude.ts`        | `claude` session wrapper (spawn, session-id, usage capture) |
| `src/ipc.ts`           | file-based inbox/outbox + transcript helpers |
| `src/persist.ts`       | run state, session ids, cost accounting, transcript replay |
| `src/dashboard.ts`     | the umbrella: sticky goal + orchestrator/seat tree |
| `src/parse.ts` / `src/select.ts` | context-file parsing + section selection |

## License

[Apache License 2.0](LICENSE) — © 2026 ArmoryWorks. See `NOTICE`.
