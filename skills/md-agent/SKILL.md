---
name: md-agent
description: Run a team of agent CLIs (Claude Code + Antigravity) against one goal with md-agent — delegate mechanical work to cheap seats, isolate every seat in a git worktree, verify each seat's work with a command, merge what passes. Use when a task is bigger than one session, needs several seats working in parallel, must be checked by a command rather than by reading, or should leave reviewable branches instead of edits in the tree. Also for inspecting, continuing, stopping, or journaling an existing md-agent run.
---

# md-agent

`md-agent` orchestrates a **team of agent CLIs** — `claude` and, per seat, `agy` (Antigravity) — against one goal. A stateless orchestrator (sonnet, no edit tools) holds a ledger and routes work to named **seats** over files; each seat is its own process and session. Runs live under `./runs/<run>/` in the project and are resumable.

Install: `npm install -g @armoryworks/md-agent` (or `npx @armoryworks/md-agent`). Run it **from inside the target repo**.

## When to reach for it

Use md-agent instead of doing the work inline when **any** of these hold:

- The work has a **cheap, complete check** (tests, build, lint, a grep) and is mechanical or high-volume → delegate it to an agy seat behind that check.
- Several seats can work **in parallel** on separable parts.
- The output should be **branches to review and merge**, not edits already in the tree.
- The run may **outlive the session** (hours, checkpoints, resumable later, on another machine via journals).

Do not use it for judgement-only work with no command to prove the result and no parallelism — a single session is cheaper and better. The rule: **where a command can prove the result, delegate; where the only check is judgement, keep it on claude.**

## The harness: delegate → isolate → verify → admit

- **Seats**: `provider: "claude"` for judgement, review, anything that can be quietly wrong, customer-facing or legal surfaces; `provider: "agy"` for enumeration, extraction to a schema, applying a known change repeatedly, first-pass drafts a verifier will check. agy content goes to Google — never health, client, or confidential data. Tiers `opus | sonnet | haiku` map per provider (agy: `gemini-3.1-pro-low` / `3.8-flash-medium` / `3.8-flash-low` — low/medium reasoning on purpose; Antigravity's individual plan is a **weekly** cap); a concrete model id passes through. A seat's turn is a long agentic loop inside its CLI, so give agy seats small, well-scoped asks; `turnTimeoutSec` caps a turn (300 agy / 600 claude). `escalate: false` pins a cheap seat so a verify failure elsewhere can't promote it.
- **Isolation**: `"worktree"` gives each seat its own git worktree + branch `md-agent/<run>/<seat>`; nothing lands in the user's tree until merged. Needs a git repo.
- **Verify**: `{ "cmd": "npm test", "maxFailures": 2 }`. Every seat reply is checked **in that seat's workspace**; a seat that claims done while it fails gets the output straight back. The run completes only when every changed workspace passes. `escalation: ["sonnet","opus"]` promotes unpinned seats on repeated failure.
- **Admit**: teardown prints each seat's branch, diffstat and PASS/FAIL; the user merges what passed (`git merge <branch>`) and drops the rest (`git worktree remove <dir>`).
- Seats that edit need `permissionMode: "acceptEdits"`; seats that run commands need `"bypassPermissions"` (headless agents can't prompt).
- **Budget**: `{ "usd": {"soft":5,"hard":15}, "fiveHourPct": {"soft":70,"hard":90} }` — the window percentages are read live from the claude CLI. Soft = wind down, hard = clean HALT, resumable.

## Commands

| Command | Does |
|---|---|
| `md-agent` | Home screen: **Continue** the latest unfinished run/journey, launch `md-agent.launch.json`, resume a specific run, look inside a seat, combine runs, journals, shelve/restore. |
| `md-agent init` | Write a starter `md-agent.launch.json` (agy worker pinned behind verify + claude reviewer + worktree isolation + budget, with an inline `$help`). |
| `md-agent --launch md-agent.launch.json` | Start a run from a config, no wizard. Fully specified configs skip the bootstrap LLM turn. |
| `md-agent --resume runs/<dir> [--quiet]` | Resume a run (seats reattach to sessions). |
| `md-agent --journey journey.json [--from <phase>]` | Multi-phase run with handshakes between phases; `--from` resumes an unfinished/halted phase in place. |
| `md-agent --inspect runs/<dir> [--seat <name>]` | A seat's trace: prompts, tool calls, results, denials, cost per turn. |
| `md-agent --stop runs/<dir>` | End a running (detached) run cleanly. |
| `md-agent --help` | Usage. |
| `md-agent skill install [--project]` | Put this skill into `~/.claude/skills/` (or the project's `.claude/skills/`). |

In the setup wizard the **goal comes first**, then journals, then a fork: **have Claude plan the team** (a high-tier model reads the goal and the repo and recommends seats, verify, isolation, budget — launch it, save it as the launch file, or adjust by hand) or set it up by hand.

During a run, typed at the console: `show <seat>` opens its trace; `stop` / **ctrl-x** stops seats (hand off to another seat, or abandon for the orchestrator); `journals` turns journaling back on; `exit` ends the run. At checkpoints: feedback text, `extend N`, `interval N`.

## Choosing seats with the user

Before launching, **put each seat to the user** — never pick a provider or tier silently. For every seat, show (AskUserQuestion, one question per seat, or one multi-part message if there are only two or three):

- **Recommended:** `provider · tier` (the concrete model id), marked as the recommendation, with **one sentence of why** — what the work's check is, and what would go wrong on a cheaper or a pricier choice. Put it first.
- **Alternatives:** the other provider · tier pairs with what each is good for and what it costs:
  - `claude · opus` — deepest judgement; architecture, security, ambiguous calls, the reviewer over other seats. $5/$25 per M tokens.
  - `claude · sonnet` — strong default for engineering, analysis, writing that can be quietly wrong. $2/$10.
  - `claude · haiku` — mechanical, narrow, high-volume work on the Claude plan (no Google egress). $1/$5.
  - `agy · pro-low` — Gemini Pro at low reasoning; breadth with some judgement, behind a verifier. 1.5× Antigravity units, weekly cap.
  - `agy · flash-medium` — enumeration, extraction, applying a known change, first drafts a command checks. 1× units, weekly cap.
  - `agy · flash-low` — the cheapest seat: bulk, mechanical, fully verifiable. 1× units, weekly cap.
- The user's pick replaces the recommendation. For an agy seat, also ask whether escalation may promote it (default no — keep the cheap seat cheap), and note that `acceptEdits` on agy grants edits but not commands.

The wizard's *Review each seat* step does the same thing interactively; the rule here is for when Claude writes the launch config itself.

## Launch config shape

```json
{
  "name": "lint-sweep",
  "goal": "Fix every lint:standards violation in src/ without changing behavior; keep the ratchet green.",
  "roles": [
    { "name": "worker",   "description": "Enumerate violations, fix each, run the check, report file paths.", "provider": "agy",    "model": "sonnet", "escalate": false, "permissionMode": "acceptEdits" },
    { "name": "reviewer", "description": "Read the worker's diff for behavior drift; say no when it should.",     "provider": "claude", "model": "opus",   "permissionMode": "acceptEdits" }
  ],
  "verify": { "cmd": "npm run lint:standards && npm test", "maxFailures": 2 },
  "isolation": "worktree",
  "escalation": ["sonnet", "opus"],
  "budget": { "usd": { "soft": 5, "hard": 15 } },
  "autoComplete": true,
  "maxMinutes": 15
}
```

## Journals

A run's record (state, ledger, transcript, traces, spend, `JOURNAL.md`) can be pushed to a **private repo per project** (`<owner>/<project>-md-agent`) and pulled elsewhere. md-agent asks at the end of every run — including interrupted ones — unless told "never"; a public repo is refused; journals are scanned for credential shapes first. Never commit `runs/` to the project repo.

## Watching a run

- `md-agent --status runs/<dir>` — one digest: elapsed time, the last transcript headings, the ledger's artifacts, and per seat its tool calls by kind, what it is on right now, its last spoken line and cost.
- `md-agent --watch runs/<dir> [--every N]` — the same digest, printed whenever it changes (default every 2 min), until the run ends or HALTs.
- `md-agent --inspect runs/<dir> --seat <name>` — a seat's full trace: prompts, tool calls, results, denials, cost per turn.
- `tail -f runs/<dir>/transcript.md` — every message, checkpoint and verify result as it happens.
- `md-agent --watch runs/<dir> --once` — one frame of the **umbrella** (goal, orchestrator, every seat's state, spend, windows, recent events) as text — paste it into a message to show the user where the run stands. On a terminal, `--watch` without `--once` is the live panel.
- `md-agent --stop runs/<dir>` — end a detached run cleanly (`touch runs/<dir>/STOP` does the same). Seats told to exit, workspaces audited and verified, `endedAt` stamped. Never kill the PIDs first.
- `HALT.txt` in the run folder means the run stopped itself — the watchdog, the verify circuit breaker, a hard budget line, or the loop guard; the file holds the reason. `--resume` / *Continue* clears it. A seat out of quota stops itself and says so in its outbox with the reset time; the orchestrator reassigns.
- From the console the run was started in: `show <seat>`, `stop` / ctrl-x, `journals`, `exit`.

**Watching is the default, and it means progress, not just endings.** Whenever Claude launches or resumes a run it does this without being asked: starts the run detached (`md-agent --launch … > run.log 2>&1 < /dev/null &`); arms `md-agent --watch runs/<dir>` as a background watch so each digest is reported as it lands; arms a second watch on `run.log` for `verify`, `checkpoint`, `HALT`, `loop-guard` and the teardown branch list; and prints the `--status`, `--inspect` and `tail -f` commands so the user can follow along in a terminal. Between events Claude answers "what is it doing" from `--status`, never with "waiting". **Show the umbrella by default:** when reporting on a run — at launch, on each digest that lands, at checkpoints and at the end — include the output of `md-agent --watch runs/<dir> --once` so the user sees the run's state as a panel, not only prose; the digest is for Claude to read, the umbrella is for the user to see. A detached run has no console, so `show`/`stop`/`exit` are not available for it; use `--stop`, or start `md-agent --launch` in your own terminal and let Claude watch the same files.

## Reading a run

- `runs/<dir>/ledger.md` — the orchestrator's memory; `## Artifacts produced` lists outputs.
- `runs/<dir>/transcript.md` — every message, checkpoints, verify results.
- `runs/<dir>/log/<seat>.jsonl` — the seat's verbatim stream; read it with `--inspect`.
- `runs/<dir>/state.json` — goal, seats, status (`endedAt`, `HALT.txt` alongside means halted), journey ref.

## Env

`MD_AGENT_ORCH_MODEL` (default `sonnet`), `MD_AGENT_ORCH_TOOLS=all` (give the orchestrator edit tools back — off by default), `MD_AGENT_PLANNER_MODEL` (default `claude-fable-5-1`), `MD_AGENT_ROLE_PERMISSION_MODE`, `MD_AGENT_CHECKPOINT_GRACE`, `MD_AGENT_HOME` (config + journal clones). Full table in the README.
