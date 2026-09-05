# md-agent efficiency and quality pass — 2026-09-05

Target: this checkout, `main` @ `1f74533` (v1.8.0). Read: every file in `src/` that touches a
turn (orchestrator, role, claude, agy, ipc, workspace, team, plan, journey, persist, watch).
Data: the seat traces and cost files of the four runs on this machine (two `self-analysis`
runs here, two `tools-once-over` runs in aw-tools) plus five live `claude -p` haiku probes to
measure the fixed per-call prefix. Claude CLI 2.1.261, agy as installed. No source changed.

Where the money goes, from the $4.33 self-analysis run (2 claude seats, 6 orchestrator turns):

| participant | turns | cache read | cache write | output | cost | share |
|---|---|---|---|---|---|---|
| analyst (opus) | 3 | 1.41M | 144k | 26k | $2.80 | 65% |
| challenger (sonnet) | 5 | 2.49M | 107k | 22k | $1.15 | 27% |
| orchestrator (sonnet) | 6 | 124k | 66k | 9k | $0.38 | 9% |

The orchestrator is already cheap and flat (20.6k cached read + ~11k write + ~1.7k out per
turn, ~$0.06). Nearly everything is inside seat turns: one 28-call opus turn cost $2.45, of
which cache reads were ~$0.55, cache writes ~$0.82, output ~$0.60. So the levers, in order:
what a seat re-reads on every call (resident context + fixed prefix), how many calls a turn
makes, and turns that should not have happened at all (recycle handoffs, noise verifies).

Findings are ordered by expected payoff. Each has the smallest fix I would make.

---

## E1 — Recycle-by-size measures turn *work*, not resident context; it fired after every real turn

`src/role.ts:275-279` recycles when `usageTokens(session.lastUsage) >= 200_000`, and
`usageTokens` (`src/persist.ts:412`) is input + cache read + cache write + output **summed over
every API call of the agentic loop**. Any turn with more than ~8 tool calls exceeds 200k
regardless of how big the session actually is.

Observed (self-analysis run, v1.7.0):

| seat | turn | what it was | resident ctx at end (last call in+cr+cw) | usageTokens | recycled next? |
|---|---|---|---|---|---|
| analyst | 1 | real work, 28 calls | 144k | 1.25M | yes |
| analyst | 2 | **recycle handoff** ($0.106, 16s) | — | — | — |
| analyst | 3 | real work, 7 calls | 24k | 184k | — |
| challenger | 1 | real work, 26 calls | 75k | 1.44M | yes |
| challenger | 2 | **recycle handoff** ($0.029, 16s) | — | — | — |
| challenger | 3 | real work, 15 calls | 57k | 762k | yes |
| challenger | 4 | **recycle handoff** ($0.024, 17s) | — | — | — |
| challenger | 5 | real work, 8 calls | 37k | 283k | (run ended) |

Three of eight seat turns were handoffs; every substantive turn triggered one. Direct cost
$0.16 (4%), ~50s of wall clock, and each fresh session re-found its bearings ("Let me just page
through with Read to find the F4 section"). The economics of recycling a genuinely fat context
are fine — after the analyst's recycle its per-call read dropped 144k→24k — the defect is the
trigger: a 40-call grep-heavy turn on a 30k context recycles; a 75k sonnet context gets thrown
away for a $0.03 handoff that saves less than that.

**Smallest fix.** Measure the resident context directly. Every `assistant` message in the
stream carries `message.usage` for *that* call; the last one's
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` is the context the next
call will start from. In `src/claude.ts` stdout handler (`:279`), keep
`this.lastContextTokens` from the latest assistant `usage`; expose it on `AgentSession`
(`src/claude.ts:78`); in `src/role.ts:275` test `session.lastContextTokens >= RECYCLE_TOKENS`
instead of `usageTokens(lastUsage)`. For agy, sum nothing — use the last `step_update.usage`
`input_tokens + cache_read_tokens` (`src/agy.ts:181-192`, see E3). Keep the 200k default; it is
now a per-call figure and means what the comment at `src/role.ts:57-62` says.

---

## E2 — Seat replies carry the seat's interim narration, not just its report

`src/claude.ts:279-285` concatenates **every** text block of every assistant message in the
turn into `assistantText`; the CLI's `result` field (`:314`) is used only when that is empty.
In all 8 seat turns in the trace `result` equalled exactly the **last** text block. So the
outbox — and therefore the transcript, the orchestrator's event, and the next dispatch the
orchestrator paraphrases from it — contains the pre-tool chatter ("Now I'll verify S6–S10…",
"S8 fully confirmed… Now S9, S10…", "I'll apply both edits.") stitched in front of the report.
Measured: 15–20% extra chars per reply (challenger turn 1: 2420 vs 2019; turn 3: 2079 vs 1744),
and the orchestrator reads all of it every later turn via the ledger it derives.

**Smallest fix.** At `src/claude.ts:314`, prefer `msg.result` when it is a non-empty string;
fall back to the last text block; fall back to the concatenation only if both are empty. Two
lines. (The transcript keeps the full trace anyway in `log/<seat>.jsonl`.)

---

## E3 — agy reports *conversation-cumulative* usage; md-agent books it as per-turn

`src/agy.ts:279` → `extractUsage(obj)` reads the `result` envelope's `usage`. The aw-tools
worker trace (one conversation, three turns):

| turn | steps | wall | envelope input | envelope cache read | envelope output | `num_turns` |
|---|---|---|---|---|---|---|
| 1 | 213 | 415s | 566,632 | 5,510,762 | 144,176 | 1 |
| 2 | 18 | 17s | 575,939 | 5,767,457 | 147,180 | 2 |
| 3 | 50 | 38s | 605,293 | 6,712,661 | 154,692 | 3 |

Turn 2 cannot have read 5.77M tokens in 17 seconds; the envelope is the running total for the
conversation. Consequences today: `recordUsage` (`src/persist.ts:474`) adds the total again
every turn, so an agy seat's "net" tokens in the panel, the run Σ, `budget.tokens`, and the
journal's spend figures are inflated roughly quadratically in turn count; and E1's recycle
trigger fires on every agy turn after the first big one (the conversation total never drops
below 200k), so an agy seat is recycled — handoff turn, fresh conversation — on essentially
every dispatch.

**Smallest fix.** The per-step `step_update.usage` lines are per call (input 6–10k, cache
read 8–61k in the sample). In the stdout handler at `src/agy.ts:181-192`, parse each
`step_update`, sum its `usage` fields for the turn, and use that sum as `lastUsageData`
instead of the envelope (keep the envelope as a fallback when no steps carried usage). This
also gives the per-turn step count for E9 for free.

---

## E4 — Verify runs on replies from seats whose workspace is untouched; the gate already knows better

`src/orchestrator.ts:1836` verifies every reply. `runGate` (`:1899-1907`) deliberately judges
only workspaces with changes. In the self-analysis run the review-only challenger failed
verify on **3 of 3** replies (`test -s docs/…` in its clean worktree → "(no output)"), each one a
transcript entry and a `[verify FAIL … attempt n]` block prepended to the orchestrator's event
— noise the orchestrator had to read and reason past, plus one `npm run build`-class command
per reply. The 2026-09-04 analysis flagged this as S7 with a `claimsDone` carve-out; the data
says the carve-out is still wrong for a reviewer ("**Done.** Both corrections are correctly
applied…" claims done with a clean tree).

**Smallest fix.** Make verify-on-reply follow the gate's rule exactly: under `worktree`
isolation, skip it when `!(await workspaceHasChanges(ws))` — no exception for completion
claims (a claim from a seat that changed nothing is judged by the gate over the seats that did).
Under isolation `none` keep today's behaviour (changes cannot be attributed). Add
`RoleSpec.verify?: VerifySpec | false` so a reviewer can carry its own check or none; when set
it overrides the run's `verify` in `:1840` and in `runGate`/`reportWorkspaces`. Then the
skill's "use a per-seat command" workaround stops being folklore.

---

## E5 — Teardown re-runs verify in every workspace right after the gate passed them

`stopAll` (`src/orchestrator.ts:1719-1733`) calls `reportWorkspaces` with `verifyIn`, which runs
the verify command in **every** worktree that exists (`src/workspace.ts:154-160`) — including
clean ones and the ones `runGate` verified seconds earlier. `runGate` itself (`:1910-1914`)
runs the dirty workspaces sequentially. With a 90s test suite and three seats a verified
completion pays ~4.5 min at the gate and ~4.5 min again at teardown, serially, with the
console saying "stopping".

**Smallest fix.** (a) In `runGate`, `Promise.all` the per-workspace `runVerify` calls — they are
independent processes in independent directories. (b) Remember each gate result keyed by
`(dir, git status --porcelain hash)`; in `stopAll`, pass a `verifyIn` that returns the cached
result when the key matches and only re-runs when the workspace changed since. (c) Skip verify
for a workspace with `changedFiles === 0` and print `—` instead of PASS/FAIL; an untouched
branch has nothing to admit.

---

## E6 — Hidden premium-model spend: preflight and handshake run on the CLI default (Fable) and are never recorded

- `probeProvider` (`src/orchestrator.ts:160-165`) passes no `--model` for claude, so the probe
  runs on whatever the CLI defaults to — on this machine `claude-fable-5-1[1m]`
  (`~/.claude/settings.json`) — with the full 22.7k-token prefix and all MCP servers connected,
  once per launch **and once per resume** (`:747`, `:1078`). Nothing records its cost.
- `resolveHandshakeModel` (`src/journey.ts:460-464`) returns `undefined` when neither env var is
  set, so the journey handshake author also runs on the CLI default.
- The bootstrap turn (`:784`) and the planner (`src/plan.ts:169`) report usage but never
  `recordUsage` into the run, so the run's Σ and the journal understate real spend.

**Smallest fix.** Probe with `--model claude-haiku-4-5 --tools "" --strict-mcp-config
--mcp-config '{"mcpServers":{}}' --no-session-persistence` (measured: $0.0025 and 1.1s vs
~$0.02+ and 1.9s on haiku alone; on Fable the gap is larger). Default the handshake model to
`resolveOrchModel()`. Record bootstrap/preflight/planner usage as participants
(`"bootstrap"`, `"preflight"`, `"planner"`) once the run dir exists so `readRunCost` is honest.

---

## E7 — Every seat call carries a 22.7k-token fixed prefix; ~9.5k of it is tools no seat needs

The `init` event for every seat and the orchestrator lists 138–140 tools: ~110 MCP tools
(Gmail, Calendar, Drive, Spotify, drive-mcp — all five servers *connected* on every process
start), 53 slash commands, 18 skills, 5 agents. Measured with haiku probes in this repo
(cache read + cache write on a trivial call = the prefix):

| configuration | prefix tokens | wall |
|---|---|---|
| default | 22.7k | 1.9s |
| `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | 21.1k | 1.5s |
| + `--tools Read,Bash,Edit,Write,Glob,Grep` | 13.2k | 1.1s |

MCP tools are deferred (names only), so they cost little in tokens but ~0.4s of startup per
process; the built-in extras (Task, Cron*, Workflow, Monitor, SendMessage, RemoteTrigger,
DesignSync, ReportFindings, ScheduleWakeup, EnterWorktree, …) are the 9.5k. Per call that is
nothing; per **turn** it is calls × 9.5k: the analyst's 28-call turn re-read ~266k tokens of
tool schemas it could not use (~$0.13 of $2.45 on opus, ~5%). It also removes a quality hazard:
a seat with `Task` can spawn subagents whose activity is neither in its trace nor its cost
line, and a seat with Gmail/Drive tools has an egress path the mandate never mentioned.

**Smallest fix.** `RoleSpec.tools?: string[]` (default
`["Bash","Read","Edit","Write","Glob","Grep","WebFetch","WebSearch"]`) → `--tools` at
`src/claude.ts:208`; `RoleSpec.mcp?: "inherit" | "none"` (default `"none"`) → the two MCP flags.
The orchestrator gets `--tools Read,Glob,Grep`, no MCP, `--disable-slash-commands`, and
`--no-session-persistence` (it is stateless; today every turn writes a ~30k-token session file
under `~/.claude/projects/` that is never resumed). The planner keeps read tools; the bootstrap
and probe get `--tools ""`.

---

## E8 — Neither the orchestrator nor the seats are told the verify command, the workspace, or the isolation rule

`buildOrchSystem` (`src/orchestrator.ts:284-363`) never mentions `verify.cmd` or `isolation`;
the orchestrator first learns the command from a `[verify PASS/FAIL …]` event. The seat
mandate (`src/role.ts:105-124`) says "run the verify or test once" without naming it, and never
states the seat's workspace path or branch, or that the repo root is off limits — the exact
failure the agy worker had (it wrote into the main checkout) and the reason `--add-dir` was
added. `workspaceDir` is known at `src/role.ts:166-175` and only printed to the console.

**Smallest fix.** In the seat mandate add, when present: `Your workspace: <dir> (branch
<branch>). Every edit and every command runs there; never touch <repoDir>.` and `The run's
check is: \`<verify.cmd>\` — run exactly that before reporting done.` In the orchestrator
system prompt add one line each for `verify.cmd`, `isolation`, and per-seat overrides from E4.
Under 100 tokens per turn; it removes the "seat ran a different check than the gate" class
outright and lets the orchestrator size dispatches to the real check.

---

## E9 — Per-turn caps: `--max-budget-usd` exists for claude; agy has a step counter for free

The 2026-09-04 report's F5 asked for a per-turn token/step cap. This CLI has no `--max-turns`
in print mode (checked `claude --help`), but it does have `--max-budget-usd <amount>` (print
mode). For agy the stream already carries one `step_update` per call (213 in the worker's first
turn).

**Smallest fix.** `RoleSpec.turnBudgetUsd?: number` → `--max-budget-usd` at
`src/claude.ts:208` (claude seats); `RoleSpec.turnMaxSteps?: number` (default 80 for agy) →
count `step_update` events in `src/agy.ts:181-192` and kill + reject with the existing
"re-scope it smaller" message. Both are the deterministic bound the wall-clock cap only
approximates; a 200-step turn that finishes in 290s currently passes.

---

## E10 — Budget-aware routing: the orchestrator never sees per-seat spend

`timeStatus()` (`src/orchestrator.ts:1178-1191`) gives the orchestrator elapsed time and, once
crossed, a soft-budget note. It never sees which seat is expensive. When the soft line hits,
"wind down" is the only move it can make; "route the remaining mechanical work to the haiku
seat" is not available to it because it does not know the opus seat has spent 65% of the run.

**Smallest fix.** Append one line to the ⏱ block: `spend: analyst $2.80 (opus) · challenger
$1.15 (sonnet) · orch $0.38` from `readCost` per role (already read for the dashboard in
`showRoleTurnCost`). ~30 tokens per turn.

---

## E11 — Robustness nits on the LLM plumbing (small, free)

- **Structured output.** `claude` and `agy` both accept `--json-schema`. Use it for the
  bootstrap turn (`src/orchestrator.ts:755-786`), the planner (`src/plan.ts:143-163`) and the
  handshake author (`src/journey.ts:360-376`) instead of `extractJson` on free text.
- **`--fallback-model`** (print mode) for seats and the orchestrator: an overloaded opus
  becomes a sonnet turn rather than a `[ROLE ERROR]` and an orchestrator turn to re-dispatch.
  Off by default; `RoleSpec.fallbackModel`.
- **`--effort`** is a per-session knob on both CLIs. For haiku/mechanical seats `low` cuts
  thinking tokens (the opus analyst spent 8k of 24k output tokens thinking). `RoleSpec.effort`,
  no default change.

---

## E12 — Small wall-clock items

- `watchFile` (`src/ipc.ts:74-77`) uses `awaitWriteFinish` (100ms stability + 50ms poll). Every
  write is already an atomic rename (`safeWrite`), so the stability wait only adds ~150ms per
  hop, twice per exchange. Drop it, or keep it only for the sentinel-era files.
- `seatDigest` (`src/watch.ts:291`) re-reads and re-parses each seat's whole `.jsonl` on every
  `--watch` tick (746 KB after a 14-min run; an agy seat's log grows by ~60 KB per hundred
  steps). Remember the byte offset per seat and parse only the appended tail.
- The orchestrator spawns a new `claude` process per turn (stateless by design). E7's flags
  take its startup from ~1.9s to ~1.1s; over a 45-min run of 40 turns that is half a minute.

---

## Not worth doing (checked, so nobody re-derives it)

- Moving the orchestrator's 7k-char system prompt into `--append-system-prompt` so it caches
  across turns: saves ~1.8k tokens × (write − read price) ≈ $0.004 per turn. The orchestrator's
  whole turn is ~$0.06; leave it.
- Shrinking the orchestrator's prefix for token cost: 9.5k × $0.20/M = $0.002 per turn. Do it
  for the startup time and the tool hygiene (E7), not the tokens.
- Ledger size: 1.5–4.7k chars in every run seen; the 8k nudge has never fired. Fine as is.
- Event coalescing, the spill choke-point, the context.md pointer: all present and never
  triggered in these runs; the orchestrator's prompt peaked at 12.8k chars.
- The worktree-without-`node_modules` question: `npm run build` passed in the analyst's
  worktree only because npm and tsc walk up to `md-agent/node_modules` (the run dir lives inside
  the repo). A Python/venv or Go project would not get that accident. A `setup` command per run
  (`{"setup":"npm ci"}` run once per provisioned worktree) is the durable answer; low priority
  until a non-node target hits it.

---

## Suggested order

1. **E1 + E3** together (both are "measure the right number"): resident-context recycle
   trigger, per-turn agy usage from `step_update`. Fixes recycle-every-turn on both providers,
   agy budgets, and the panel's Σ.
2. **E2** (`result` over concatenation) and **E4** (verify follows the gate's rule; per-seat
   verify). Cleaner orchestrator input, no phantom FAILs, no reviewer bounce loop.
3. **E6** (haiku probe, handshake on sonnet, record hidden turns) and **E7** (tools/MCP flags,
   `--no-session-persistence`). Mostly flag strings.
4. **E8** (verify command + workspace in mandates) and **E10** (spend line). Prompt text only.
5. **E5** (parallel gate, no teardown re-verify), **E9** (per-turn caps), **E11/E12** as
   time allows.

Everything above is testable in `smoke-providers.ts` with the fake CLIs it already has:
feed a stream with two `assistant` messages plus a `result`, assert the reply is the last
block and `lastContextTokens` is the last call's usage; feed three agy `step_update`s with
usage and a cumulative envelope, assert the per-turn sum.
