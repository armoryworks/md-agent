# Proposal: deterministic verification gate, payload choke-point, caching measurement, and `--from` finish-off

_Status: draft · 2026-05-26 · author: design discussion_

Pulls the genuinely additive ideas out of the "C# hub/spoke" sketch and adapts
them to md-agent **as it actually is** (Node/TS, one stateless orchestrator +
role children, each a real `claude` CLI process, coordinating over files). It
explicitly does **not** adopt the parts that would fight md-agent's grain (a
Redis/GUID payload store, a C# rewrite, caching-as-primary-strategy).

The four pillars of the source sketch mapped onto md-agent:

| Pillar | Verdict | Action here |
|---|---|---|
| 1. State/context split | Already the core design, soft-enforced | **P2** — add a deterministic payload choke-point |
| 2. Pointer pattern + store | Equivalent via filesystem; a store would hurt a code agent | Not adopted (delegate versioning to git) |
| 3. Deterministic supervisor / circuit breaker | **Real gap** | **P1** — verification gate + failure cap |
| 4. Provider prompt caching | Complementary half md-agent leaves on the table | **P3** — measure first, then decide |

Plus three additions that are **not** from the C# sketch:
- **P0** — finish the `--from` work already in the working tree.
- **P1b** — an **orchestrator / phase-progress watchdog** for an orchestrator-side
  stall found in the phase-38 gating run. Most urgent of all of these: it can
  silently stall the catch-up run the same way.
- **P4** — a **launch-time agent preflight** (fail-fast readiness probe), from the
  multi-provider/Gemini-delegation thread but deliberately scoped down: no
  autodetection, no provider registry — just verify the agent a run already uses
  is actually authed and responsive before it commits.

A second augmentation batch (Aider search/replace, semantic routing, escalation
tiering, YAML minification) was also evaluated. Only **escalation tiering** earned
a place — **P1c** below; the other three are in _Considered & declined_.

---

## P0 — Finish `--from` (already implemented, uncommitted)

`src/journey.ts` and `src/index.ts` in the working tree already implement
`--from <phase-id>`: `runJourney` takes `{ from }`, resolves a `startIndex` via
`findIndex`, errors on an unknown id, logs skipped phases, and loops from
`startIndex`. That closes the original gap. Remaining loose ends:

1. **Commit + rebuild `dist/`.** The change is uncommitted and `dist/` is stale
   (May 21 vs `src/` May 22+), so `node dist/index.js --journey … --from …`
   would silently run the *old* behavior. Only `npm run dev` (tsx) picks it up.
   → `npm run build` then commit, so both entry points agree.
2. **Update the stale HALT message.** The empty-ledger crash-guard still says
   _"Re-run the journey (or a from-<id> manifest)"_ — now that the flag exists it
   should name it: _"resume with `--journey <m> --from <id>`"_.
3. **Document the context-inheritance caveat.** `--from` only inherits upstream
   context if the skipped phases **actually ran before** (their handshakes live
   in `phases/<id>/INBOX.md`). On a *fresh* journey, `--from` midway starts the
   resumed phase with **no upstream handshake**. The in-code comment assumes a
   prior partial run; the README should say so explicitly.
4. **(Optional) Warn on misuse.** `--from` is read in `index.ts` but only honored
   in the `--journey` branch; passed with `--launch`/`--resume` it's silently
   ignored. A one-line warn ("`--from` has no effect without `--journey`") avoids
   a confusing no-op.

No new types needed; this is finish-and-document.

---

## P1 — Deterministic verification gate + circuit breaker (the headline win)

**Problem.** md-agent decides "done" with the *LLM itself* (`[[PHASE-COMPLETE]]`,
`src/orchestrator.ts:640`) and bounds cost only by *time* (soft budget, which
even tolerates over-runs). There is **no hard, non-LLM gate** that a phase's work
actually builds/passes, and no deterministic loop-breaker — exactly the failure
mode the source sketch targets ("don't burn $5 autonomously fixing a semicolon").

**Design — "LLM fixes, a deterministic gate decides."** Keep the LLM in the loop
for *doing the work*, but make the *success decision* and the *loop-break*
deterministic.

### Schema additions

```ts
// persist.ts — RunState, and mirrored onto LaunchConfig + JourneyPhase
interface VerifySpec {
  /** Shell command whose exit code gates completion. 0 = pass. e.g. "npm test", "dotnet build". */
  cmd: string;
  /** Working dir for the command (the target repo, NOT runDir). Default: process.cwd(). */
  cwd?: string;
  /** Consecutive failures tolerated before the run HALTS to the human. Default 2. */
  maxFailures?: number;
  /** Seconds before the verify command is killed + counted as a failure. Default 600. */
  timeoutSec?: number;
}
// RunState/LaunchConfig/JourneyPhase gain:  verify?: VerifySpec
```

Threading mirrors the existing `autoComplete` field exactly: `LaunchConfig` /
`JourneyPhase` → `RunState` (persisted in `state.json`, so resume keeps it) →
`launchRun` setup → `runLoop` ctx.

### Integration point — gate `[[PHASE-COMPLETE]]`

In `askOrch`'s autoComplete branch (`src/orchestrator.ts:640`), when the sentinel
is detected **and a `verify` spec exists**, do not tear down yet:

```
detect [[PHASE-COMPLETE]] (no TO: blocks)         ← unchanged trigger
  └─ verify.cmd in verify.cwd ──► exit 0  → honor completion (stopAll → handoff)
                                └► exit≠0  → DO NOT complete:
                                     • failures++ ; append tail(stdout/stderr) to transcript
                                     • if failures > maxFailures → HALT (see below)
                                     • else feed a new event back to the orchestrator:
                                         "[SYSTEM/verify] FAILED (exit N). <tailed output>.
                                          Fix and re-verify before completing."
                                       → orchestrator gets another turn to fix
```

The verify runner is a small `spawn`/`cross-spawn` helper (cross-spawn is already
a dep) capturing exit code + tailed output, with the `timeoutSec` kill. Reuse the
`tail()` style already added to `claude.ts`.

### The circuit breaker (HALT)

When `failures > maxFailures`, stop deterministically and **escalate to the
human**, mirroring the journey empty-ledger crash-guard so a journey does **not**
advance past a phase that never actually passed:

- Write `runDir/HALT.txt` with the reason + last verify tail.
- Print a clear `[verify] HALT` message; append `VERIFY HALT` to the transcript.
- Exit the phase process non-zero.
- The journey driver, right after `spawnPhase` (`src/journey.ts:143`), already
  inspects the ledger for the empty-ledger guard — add a sibling check: if
  `runDir/HALT.txt` exists, **stop the journey** (don't write handshakes, don't
  advance), same as the empty-ledger path.

### Why this shape

- **Deterministic decision, LLM remediation.** The model still fixes the bug; it
  just can't *declare victory* unverified, and it can't loop forever.
- **Project-agnostic.** `verify.cmd` is whatever the target repo needs
  (`dotnet build`, `npm run typecheck`, a regex script) — md-agent stays generic.
- **Reuses existing machinery.** Same teardown as `exit`, same halt semantics as
  the empty-ledger guard, same event-feedback loop as the watchdog re-issue.
- **Backward compatible.** No `verify` → behavior is exactly as today.

---

## P1b — Orchestrator & phase-progress watchdog (orchestrator-side stall)

_Not from the C# sketch — a separate bug found in the phase-38 gating run. Rolled
in here because it's the most urgent: it can stall the catch-up run the same way,
and the `claude.ts` error-surfacing fix won't catch it (no subprocess crashes)._

**What happened (phase 38).** `gating-operator` finished its turn (~16:44, produced
11 findings) and went idle. The orchestrator had written "drive phase 38 finalize
+ commit" to its ledger but **dispatched no `TO:` block and emitted no
`[[PHASE-COMPLETE]]`**. From there nothing re-invoked it: the role was done (removed
from `pendingSince`) so the role watchdog stopped watching it, and the checkpoint
no-input branch (`src/orchestrator.ts:882`) **deliberately re-arms without nudging**
(`askOrch` is *not* called on auto-continue — an intentional "don't burn a turn /
invent work" choice). The run idled — auto-continuing every 120s, never taking
another orchestrator turn — until a manual Ctrl-C (the `SIGINT` in the transcript).
~50 min lost.

**Why nothing caught it.**
- The **heartbeat is an output-liveness signal, not an idleness monitor**
  (`src/claude.ts:55` — `beat()` fires only on stream output). A finished, idle role
  stops beating; a stale heartbeat means "done," not "hung." Correct as designed.
- The **role watchdog only inspects `pendingSince`** (`src/orchestrator.ts:1021`) —
  roles with an *outstanding* task. A finished role is invisible by design (else it
  would "recover" roles merely waiting for the next dispatch).
- **Nothing watches the orchestrator itself, or phase advancement.** No signal
  forces a stalled orchestrator forward or halts it.
- **Recovery re-enters via `askOrch`** — another orchestrator turn — so a recovery
  attempt can itself stall on the very thing that's stuck (gap #3).

### The deadlock signature (fully internal — no workspace assumptions)

The orchestrator only advances when something calls `askOrch`: a role outbox reply,
a user line, a checkpoint *with* input, a team result, or a watchdog recovery. The
auto-continue path calls none of these. So the deadlock is precisely:

> **no orchestrator turn for > N min** (≈ `ledger.md` mtime unchanged — it's
> rewritten every turn) **AND no outstanding role work** (`pendingSince.size === 0`)
> **AND no active huddle** (`teamOwner.size === 0`) **AND the orchestrator isn't
> mid-turn** (`!orchBusy`).

When all four hold, nobody is coming to re-invoke the orchestrator. That's the hole.

### Design — extend the existing watchdog block (it already has the 60s interval)

**(a) Give the orchestrator a heartbeat** (closes gap #3 — a *mid-turn* hang). The
orchestrator `ClaudeSession` is created with no `heartbeatPath`
(`src/orchestrator.ts:264`); pass `sessions/orchestrator.heartbeat`. In `runLoop`
track `orchBusy` (set around the `askOrch` critical section) and `lastOrchTurnAt`
(set on each `askOrch` completion).

**(b) Phase-progress watchdog** — in the existing `setInterval`
(`src/orchestrator.ts:1018`), after the role loop:

```
if (orchBusy):                       // orchestrator is mid-turn
    if orchestrator heartbeat stale > ORCH_HANG_MS  → HALT
        # its own claude turn is hung; do NOT self-recover (recovery re-enters
        # the stuck path). Escalate to the human.
else if (pendingSince.size === 0 && teamOwner.size === 0):
    idle = now - lastOrchTurnAt
    if idle > ORCH_STALL_MS:
        if (nudges < MAX_ORCH_NUDGES):
            nudges++; force ONE turn:
              askOrch("[SYSTEM/progress] No role work outstanding and no
                       orchestrator turn for ~{idle}m. If the goal is met,
                       finalize and emit [[PHASE-COMPLETE]]; otherwise dispatch
                       the next concrete step now.")  → dispatch
        else:
            escalate  (onStall: "halt" (default) | "finalize")
```

- A nudge that produces a `TO:` block → role gets work → `pendingSince` non-empty →
  watchdog goes quiet (normal). A nudge that produces `[[PHASE-COMPLETE]]` → clean
  teardown + handoff. **Reset `nudges` to 0 on any real dispatch or role reply**, so
  transient idles don't accumulate toward escalation.
- **Escalation default = HALT** — write `runDir/HALT.txt` + stop the journey, reusing
  P1's halt check at `src/journey.ts:143`; resume later with `--journey … --from <id>`.
  Auto-`finalize` (commit what's on disk + synthesize completion) is **opt-in
  per phase**, because committing un-reviewed work from a stuck phase is a risky
  default.
- Knobs: `MD_AGENT_ORCH_STALL` (default 600s), `MD_AGENT_ORCH_HANG` (mid-turn,
  default ~360s, matching the role stall), `MD_AGENT_ORCH_MAX_NUDGES` (default 2),
  per-phase `onStall: "halt" | "finalize"`.

### Why it can't false-fire on a legitimate wait

When the orchestrator is correctly waiting on an in-flight role, that role is in
`pendingSince` (so the `=== 0` guard fails) and the existing role-heartbeat watchdog
already covers a *hung* role. The progress watchdog fires only when there is
genuinely nothing left to re-invoke the orchestrator — the exact deadlock above.

### For the imminent catch-up run (until this lands)

Manual signal that this stall is happening: **no new file in the phase's run dir and
no new `findings/` file for >10 min while the tab sits at a checkpoint** → Ctrl-C and
resume with `--from <phase-id>`. (That's the human-observable proxy for "ledger mtime
not advancing + no role pending.")

---

## P1c — Escalation tiering (cheap-first, upgrade on deterministic failure)

_Depends on P1 — it has no trigger without a deterministic pass/fail. Adopted from
the second augmentation batch; the rest of that batch is in **Considered & declined**._

**Idea.** md-agent already assigns a per-role model tier at bootstrap by cognitive
load — but **statically** for the whole run. Make it **dynamic** for *verifiable*
roles: start one tier lower, and when P1's verify gate fails `K` times, re-spawn the
role's session one tier up, handing it the failure context.

**Why it fits.** Reuses machinery that already exists — per-role `model` in
`RunState`, `respawnRole` (`src/orchestrator.ts:969`), and P1's failure counter —
and targets the **role seat, the bigger cost**. If haiku clears ~70% of mechanical,
machine-checkable edits at a fraction of opus's cost, the saving is large.

**Design.**
- Per-role `escalation?: { ladder?: ModelTier[]; bumpAfter?: number }`. Default
  ladder = `[oneBelowBootstrap, bootstrapTier, "opus"]`; `bumpAfter` defaults to
  P1's `maxFailures`.
- The trigger **is** P1's verify failure counter — so escalation is **scoped to
  roles that have a verifier**. A role whose output can't be machine-checked keeps
  its static bootstrap tier (escalating blind just burns the loop).
- On bump: re-spawn the role on the next ladder tier (a *fresh* session, since the
  model changes) and re-issue with context: _"The {prev-tier} attempt failed with:
  &lt;verify tail&gt;. You are the senior engineer — fix it."_
- Ladder exhausted → hand off to P1's **HALT** (circuit breaker); don't loop.
- Tiers are 4.x: `haiku-4-5 → sonnet-4-6 → opus-4-7` (`MODEL_IDS`), not the "3.5"
  the source named.

**Caveat.** A refinement of the existing bootstrap tiering, not a replacement — and
only for verifiable roles. Don't haiku-first a deep-reasoning role.

---

## P2 — Control-plane payload choke-point (harden Pillar 1, deterministically)

**Problem.** The "Hub reads pointers, not files" rule is enforced only by prompt
discipline. A role *can* paste a 4,000-token blob into its outbox and the
orchestrator *will* read it (`src/orchestrator.ts:781` outbox watcher → event).

**Design.** A deterministic size guard in the outbox→event path. If a role reply
exceeds `maxEventChars` (e.g. 8 KB), auto-spill the full text to
`runDir/spill/<role>-<ts>.md` and replace the event fed to the orchestrator with
a head excerpt + the spill path:

```
[from <role>] (reply was 14 KB — spilled to runs/<dir>/spill/<role>-….md; head excerpt:)
<first ~600 chars>…
```

This makes the choke-point structural and cheap — no payload store, no GUIDs, and
the orchestrator's resident context stays bounded even when a role misbehaves.
Config: `maxEventChars?` on `RunState` (default off or a generous 8 KB).

_Lower priority than P1; it's a safety rail, not a capability._

---

## P3 — Caching: measure first, then decide

**Reality.** The orchestrator is stateless: every turn re-sends
`systemPrompt + ledger + event` as a fresh `claude -p` process. The system prompt
is the only large *static* block, and it's already a clean prefix (the dynamic
`⏱` line and ledger come *after* it, `src/claude.ts:92` + `composeOrchPrompt`).
Because we use the **CLI, not the SDK**, we can't set explicit `cache_control`
breakpoints — caching is whatever Claude Code does under the hood, and our sparse
turn cadence (minutes between orchestrator turns while roles work) routinely
blows the ~5-min cache TTL.

**Step 1 — measure (cheap, do this first).** We *already capture*
`cacheReadTokens` / `cacheCreationTokens` per turn (`persist.ts` `Usage`). Surface
the orchestrator's per-turn **cache-hit ratio** in the dashboard/logs. If reads
are healthy, the CLI is already caching the prefix within TTL and there's nothing
to do. If reads are ~0 (cold every turn), Step 2 is justified.

**Step 2 — only if cold: move the orchestrator session to the Anthropic SDK** with
`cache_control: { type: "ephemeral" }` on the system block. This gives
deterministic prefix caching independent of CLI/TTL behavior and richer cache
metrics. Tradeoffs to weigh before doing it:

- Diverges from md-agent's "everything is a `claude` CLI process" ethos and adds
  an API-key path + SDK dependency for one seat.
- md-agent's stateless + rewrite-and-prune ledger already keeps the absolute $
  small; if measurement shows orchestrator cost is already low, the SDK switch
  may not pay for its complexity.

**Honest framing:** caching is the *complementary half* of md-agent's existing
"shrink the context" strategy, not a replacement. Adopt it only where the data
shows a cold cache is actually costing money.

---

## Explicitly NOT adopted

- **Redis/in-memory payload store + GUID indirection.** md-agent's workers are
  Claude Code instances operating on the **live working tree** (they build/test
  in place). Routing files through a `SaveFileState/GetFileState` store would
  force code *out of and back into* the repo the tools actually compile. Paths
  are the right addressing scheme here.
- **Immutable per-write snapshots in a custom store.** Delegate to **git** (and
  the transcript), which already provides this. Optional future nicety: an
  auto-commit per journey phase boundary.
- **A C# / .NET rewrite.** The valuable ideas are language-agnostic and slot into
  the existing TS modules; the runtime is not the lever.

---

## P4 — Launch-time agent preflight (fail-fast readiness probe)

_Scoped down from the "alternate-agent detection" discussion: **no autodetection,
no capability/provider registry, no fallback ladder** — just verify the agent(s)
a run is **already configured to use** are actually ready, before it commits._

**Problem.** md-agent assumes the `claude` CLI is "installed and authenticated"
but never checks. When that assumption breaks at runtime — token/rate-limit
exhaustion (the phase-35 crash), or an unauthenticated/untrusted CLI (the whole
Gemini auth + workspace-trust saga) — it surfaces as an **empty-ledger crash
mid-run**. The journey crash-guard catches it only *after* spawning a doomed phase
and reports "no ledger," not "your CLI isn't authed." At initial launch there's no
check at all.

**Design — a trivial readiness probe of the configured agent(s).** Before a run
commits, probe each provider/model the run will actually use (today: `claude`;
later: whatever a role's `provider` field names — but **only those**, never a
system scan):
- **Present** — the CLI resolves on PATH.
- **Responsive + authed** — a trivial round-trip succeeds (e.g. `claude -p "ok"`
  with a short timeout). One cheap turn confirms auth + not-rate-limited at once.
  Reuse the `claude.ts` non-zero-exit error surfacing so the message is the real
  cause (auth / rate limit / bad model), not a generic failure.
- **Fail fast** — on failure, abort the launch (or, in a journey, HALT *before*
  the phase) with an actionable message —
  `"claude present but the test call failed: <tailed error> — check auth / rate limit"`
  — instead of an empty-ledger crash.

**Where it hooks.**
- `launchRun` (`src/orchestrator.ts`): probe the orchestrator's provider/model
  (and each role's, once multi-provider) before spawning roles / entering the loop.
- Journey driver (`src/journey.ts`): a per-phase probe right before `spawnPhase`.
  This is the high-value placement — it turns the mid-journey rate-limit case
  (phase 35) into a clean pre-phase HALT (`"agent not responsive — resume with
  --from <phase> once it clears"`) *instead of* spawning a phase that dies with an
  empty ledger. Strictly better than, and complementary to, the existing
  empty-ledger crash-guard.

**Explicitly out of scope** (deferred to keep this minimal): scanning the system
for alternate agents; capability-based seat resolution; provider fallback ladders.
The probe only checks the agent(s) the run is already configured to use. The larger
"capability-resolved, auth-probed, fallback-laddered provider registry" can be
revisited once the `GeminiSession` adapter exists and there's more than one agent
to resolve between.

**Cost / escape hatch.** One trivial probe per provider per launch (and per phase,
if enabled) — cheap. Add `MD_AGENT_SKIP_PREFLIGHT=1` for offline / fast-iteration runs.

---

## Considered & declined (second augmentation batch)

- **Worker "Aider-style" search/replace blocks.** Premise — a worker emits a whole
  rewritten file that md-agent writes to disk — **doesn't hold here**. Role agents
  are Claude Code processes that edit files **directly via their own `Edit` tool**
  (already search/replace, already not whole-file), and the outbox carries a
  ≤250-word status, not file content (`src/role.ts:40`). The only leak path — a role
  pasting file content into its status — is already backstopped by **P2**. Nothing
  to add.
- **Semantic routing (local-embedding handoffs).** The orchestrator **plans and
  authors the next task**, it doesn't merely route a message to a role — cosine
  similarity can't replace task generation. md-agent runs are ambiguous coordination,
  not fixed assembly lines (and genuinely fixed sequencing is already encoded by
  journeys/phases). The orchestrator is also the cheap, bounded seat by design, so
  this adds an embedding model + per-role vectors + threshold tuning + a fallback to
  shave the *inexpensive* part of the bill — with a silent-misroute risk. Declined.
- **YAML-over-JSON context minification.** The orchestrator's hot-path prompt is the
  **ledger** (terse author-written markdown) + a prose status event — almost no JSON
  (`state.json` is not fed per turn). The 10–15% claim applies to JSON-heavy payloads
  md-agent doesn't send; the one recurring cost (the re-sent static system prompt) is
  better attacked by **P3 (cache it)** than by reformatting prose. Revisit only if
  P3's instrumentation shows formatting is a measurable fraction (it won't be much).

## Suggested sequencing

1. **P0** — commit `--from` + the `claude.ts` error-surfacing fix, rebuild `dist/`, fix HALT message, document the `--from` caveat. (small)
2. **P1b** — orchestrator / phase-progress watchdog. **Do this before the catch-up run** — it just cost ~50 min and a 16-phase run can hit it repeatedly. Contained: same watchdog block + an orchestrator heartbeat. (small–medium)
3. **P1** — verification gate + circuit breaker. (the headline; medium)
4. **P4** — launch-time agent preflight (fail-fast readiness probe). Small, provider-agnostic; would've caught both the token-exhaustion crash and the Gemini auth/trust saga at launch. (small)
5. **P1c** — escalation tiering (extends P1; verifiable roles only). (small–medium)
6. **P3 Step 1** — surface cache-hit ratio (one dashboard line). (small)
7. **P2** — payload choke-point. (small safety rail)
8. **P3 Step 2** — SDK orchestrator caching, *only if* Step 1 shows a cold cache. (larger; data-gated)

P0 + P1b are the "before you launch the catch-up" bundle; commit them together.
