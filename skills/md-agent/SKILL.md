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

- **Seats**: `provider: "claude"` for judgement, review, anything that can be quietly wrong, customer-facing or legal surfaces; `provider: "agy"` for enumeration, extraction to a schema, applying a known change repeatedly, first-pass drafts a verifier will check. agy content goes to Google — never health, client, or confidential data. Tiers `opus | sonnet | haiku` map per provider (agy: gemini 3.1 pro / 3.8 flash); a concrete model id passes through. `escalate: false` pins a cheap seat so a verify failure elsewhere can't promote it.
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
| `md-agent skill install [--project]` | Put this skill into `~/.claude/skills/` (or the project's `.claude/skills/`). |

In the setup wizard the **goal comes first**, then journals, then a fork: **have Claude plan the team** (a high-tier model reads the goal and the repo and recommends seats, verify, isolation, budget — launch it, save it as the launch file, or adjust by hand) or set it up by hand.

During a run, typed at the console: `show <seat>` opens its trace; `stop` / **ctrl-x** stops seats (hand off to another seat, or abandon for the orchestrator); `journals` turns journaling back on; `exit` ends the run. At checkpoints: feedback text, `extend N`, `interval N`.

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

From the console it was started in: `show <seat>` opens the seat's trace; `stop` / ctrl-x, `journals`, `exit` as above.

From anywhere else, the run folder is the live view:

- `tail -f runs/<dir>/transcript.md` — every message, checkpoint and verify result as it happens.
- `md-agent --inspect runs/<dir> --seat <name>` — a seat's prompts, tool calls, results, denials and cost per turn.
- `runs/<dir>/ledger.md` — what the orchestrator currently believes; `runs/<dir>/log/<seat>.jsonl` — the raw stream.
- `HALT.txt` appearing in the run folder means the run stopped itself — the watchdog (a hung or deadlocked seat), the verify circuit breaker, or a hard budget line; the file holds the reason. `--resume runs/<dir>` (or *Continue* on the home screen) clears it and picks the run up.

**Watching is the default.** Whenever Claude launches or resumes a run it does three things without being asked: starts the run detached (`md-agent --launch … > run.log 2>&1 < /dev/null &`), immediately arms a watch on `run.log` or `transcript.md` for `verify`, `checkpoint`, `HALT` and the teardown branch list so results are reported as they land, and prints the `tail -f` and `--inspect` commands above so the user can follow along in a terminal. A detached run has no console, so `show`/`stop`/`exit` are not available for it; a user who wants the console starts `md-agent --launch` in their own terminal and Claude watches the same files.

## Reading a run

- `runs/<dir>/ledger.md` — the orchestrator's memory; `## Artifacts produced` lists outputs.
- `runs/<dir>/transcript.md` — every message, checkpoints, verify results.
- `runs/<dir>/log/<seat>.jsonl` — the seat's verbatim stream; read it with `--inspect`.
- `runs/<dir>/state.json` — goal, seats, status (`endedAt`, `HALT.txt` alongside means halted), journey ref.

## Env

`MD_AGENT_ORCH_MODEL` (default `sonnet`), `MD_AGENT_ORCH_TOOLS=all` (give the orchestrator edit tools back — off by default), `MD_AGENT_PLANNER_MODEL` (default `claude-fable-5-1`), `MD_AGENT_ROLE_PERMISSION_MODE`, `MD_AGENT_CHECKPOINT_GRACE`, `MD_AGENT_HOME` (config + journal clones). Full table in the README.
