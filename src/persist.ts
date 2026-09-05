import type { FallbackRung, HealRecord } from "./heal.js";
import path from "node:path";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";

/** Model tiers the orchestrator may assign to a role. */
export type ModelTier = "opus" | "sonnet" | "haiku";

/** Concrete claude model ids per tier. Single source of truth. */
export const MODEL_IDS: Record<ModelTier, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

export const DEFAULT_TIER: ModelTier = "sonnet";

/** Coerce an arbitrary string to a known tier, falling back to the default. */
export function normalizeTier(tier?: string): ModelTier {
  return tier && tier in MODEL_IDS ? (tier as ModelTier) : DEFAULT_TIER;
}

/** Resolve a tier (or undefined) to a concrete claude model id. */
export function resolveModel(tier?: string): string {
  return MODEL_IDS[normalizeTier(tier)];
}

/**
 * Backing agent CLI for a seat. Configuration-based (set per role / via env) —
 * md-agent never auto-detects what's installed. Both providers are stateful:
 * claude resumes with --resume, agy with --conversation.
 *
 * "agy" is Antigravity, which replaced the deprecated Gemini CLI. It is not a
 * rename: the old provider was stateless and re-sent its mandate every turn,
 * while agy keeps a conversation, so an agy seat now behaves like a claude seat.
 */
export type Provider = "claude" | "agy";
export const DEFAULT_PROVIDER: Provider = "claude";

export function normalizeProvider(p?: string): Provider {
  return p === "agy" ? "agy" : "claude";
}

/**
 * What each provider is actually good for, shown in the setup wizard so the
 * choice is made against task shape rather than habit. Single source of truth:
 * the wizard renders this, and it is the place to revise the advice.
 *
 * The split that matters is not "smart vs cheap" — it is whether the work has a
 * cheap, complete check. Where a command can prove the result (tests pass, build
 * succeeds, files match), delegate freely: the check IS the audit. Where the only
 * check is judgement, the audit costs about what the work costs, so keep it.
 */
export interface ProviderProfile {
  value: Provider;
  /** One-line summary shown as the option label. */
  label: string;
  /** Task shapes this seat suits. */
  goodFor: string[];
  /** Anything the operator should weigh before choosing it. */
  caution?: string;
}

export const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    value: "claude",
    label: "claude — judgement, review, anything that can be quietly wrong",
    goodFor: [
      "resolving conflicts, and work where docs and code can disagree",
      "the reviewer/auditor seat over other roles' output",
      "tasks whose right answer may be \"don't do this\"",
      "anything touching a public, customer-facing or legal surface",
    ],
  },
  {
    value: "agy",
    label: "agy — breadth, volume, mechanical work behind a verifier",
    goodFor: [
      "enumeration and search across many files or repos",
      "extraction and summarising at volume, ideally to a schema",
      "applying a known change repeatedly",
      "first-pass drafting that a verify command will check",
    ],
    caution:
      "Content leaves this machine to Google — weigh that for customer, health or " +
      "client data. Pair it with a `verify` command or a claude reviewer rather " +
      "than trusting the reply: an agreeable wrong answer is the expensive failure.",
  },
];

/**
 * Concrete agy model ids per tier — the cheap/mid/strong rungs. agy encodes
 * reasoning effort in the id itself (…-low/-medium/-high). The rungs sit at
 * low/medium effort on purpose: a "-high" turn spends ~60k thinking tokens,
 * and a seat's turn is already a long agentic loop; pro-low is the interactive
 * default on the same plan. Name a "-high" id explicitly when a seat needs it.
 * `agy models` lists what is available.
 */
export const AGY_MODEL_IDS: Record<ModelTier, string> = {
  opus: "gemini-3.1-pro-low",
  sonnet: "gemini-3.8-flash-medium",
  haiku: "gemini-3.8-flash-low",
};

/**
 * Resolve a seat's `model` to a concrete id for its provider. A tier name maps
 * through the provider's ladder; anything else is passed through verbatim so a
 * seat can name a model the ladder has no rung for (`gemini-3.1-pro-low`,
 * `gpt-oss-120b-medium`). Unset → the default tier.
 */
export function resolveModelFor(provider: Provider, model?: string): string {
  if (model && !(model in MODEL_IDS)) return model;
  const t = normalizeTier(model);
  return provider === "agy" ? AGY_MODEL_IDS[t] : MODEL_IDS[t];
}

export interface RoleSpec {
  name: string;
  description: string;
  /**
   * Model tier (`opus`/`sonnet`/`haiku`, mapped per provider) or a concrete
   * model id passed through as-is. Unset → chosen by the bootstrap turn.
   */
  model?: ModelTier | string;
  /** Backing agent CLI for this role. Default "claude". Configuration-based. */
  provider?: Provider;
  /**
   * Tool-permission posture for this role's session, written in claude's
   * vocabulary ("acceptEdits", "bypassPermissions", "plan"). In headless print
   * mode a denied tool call simply fails, so a role that must edit files needs
   * this (or a global settings allowlist on the host). Falls back to
   * MD_AGENT_ROLE_PERMISSION_MODE, then to the CLI default.
   *
   * Both providers honour it: claude passes it to --permission-mode; agy maps it
   * onto --mode accept-edits / --mode plan / --dangerously-skip-permissions.
   */
  permissionMode?: string;
  /**
   * Explicit working directory for this role's CLI. Overrides RunState.isolation.
   * Usually left unset: with isolation "worktree" md-agent fills it in with the
   * seat's own worktree, and with "none" every seat shares md-agent's cwd.
   */
  cwd?: string;
  /**
   * Set when the user stopped this seat mid-run (ctrl-x / `stop`). A stopped
   * seat is not respawned on resume and the orchestrator is told not to
   * dispatch to it; its work was handed off or left for the orchestrator.
   */
  stopped?: { at: string; handoffTo?: string; reason?: string; resetsAt?: number };
  /**
   * Hard cap on one turn, in seconds: the CLI is killed and the turn reported
   * as an error the orchestrator can re-scope. Default 300 for agy, 600 for
   * claude. A turn is a whole agentic loop inside the CLI — every model call
   * in it re-reads the conversation — so long turns are where quota goes.
   */
  turnTimeoutSec?: number;
  /**
   * Whether the escalation ladder may promote this seat. Default true.
   *
   * Set false to pin a seat at its tier — a deliberately cheap role doing bulk
   * enumeration should stay cheap even when a verify failure escalates the rest
   * of the team, or the ladder silently turns the cheap tier into an expensive
   * one and the reason for the split is lost.
   */
  escalate?: boolean;
  /**
   * This seat's own check, over the run's `verify`. `false` = never verify this
   * seat's replies or workspace (a review-only seat that produces no artifact);
   * a spec = run that command instead of the run-wide one.
   */
  verify?: VerifySpec | false;
  /**
   * Built-in tools this seat may use (claude `--tools`). Default: Bash, Read,
   * Edit, Write, Glob, Grep, WebFetch, WebSearch — the schemas of the rest ride
   * in every call of every turn otherwise. `["default"]` = the CLI's full set.
   */
  tools?: string[];
  /** Whether the seat sees the user's configured MCP servers. Default "none". */
  mcp?: "inherit" | "none";
  /** Hard USD cap on one claude turn (`--max-budget-usd`). */
  turnBudgetUsd?: number;
  /** Hard cap on tool steps in one agy turn. Default 80. */
  turnMaxSteps?: number;
  /** claude `--fallback-model`: used when the primary is overloaded. */
  fallbackModel?: string;
  /**
   * Auto-heal ladder: where this seat moves when its provider runs dry (quota
   * reached, rate-limited, not ready at preflight). Each rung names a provider
   * (default claude) and a model (default this seat's tier, resolved on that
   * provider). Rungs on the provider that just failed are skipped. Unset → the
   * run's `fallback`, else the seat stops itself as before.
   */
  fallback?: FallbackRung | FallbackRung[];
  /** Moves this seat has made down its ladder, oldest first. Written by md-agent. */
  healed?: HealRecord[];
  /** Reasoning effort for the seat's CLI (`--effort low|medium|high`; claude also xhigh|max). */
  effort?: string;
}

/**
 * Concrete model for the orchestrator (and the other coordination turns:
 * bootstrap, handshake). MD_AGENT_ORCH_MODEL pins it (a tier name or a
 * concrete id). Unset → the sonnet tier: coordination re-reads a ledger and
 * routes; it should not inherit whatever premium model the CLI defaults to.
 */
export function resolveOrchModel(): string {
  const m = process.env.MD_AGENT_ORCH_MODEL?.trim();
  if (!m) return MODEL_IDS.sonnet;
  return m in MODEL_IDS ? MODEL_IDS[m as ModelTier] : m;
}

/** The tools a seat gets unless its RoleSpec says otherwise. */
export const DEFAULT_SEAT_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"];

/**
 * Where a role's file edits land.
 *
 * "none" — every seat edits md-agent's cwd (the target repo) directly. Simple,
 * and correct when the seats are advisory or the run is trusted end to end.
 *
 * "worktree" — each seat gets its own `git worktree` on its own branch. Seats
 * cannot overwrite each other, and the run's output becomes reviewable
 * artifacts: audit with `git diff`, keep with a merge, discard with
 * `git worktree remove`. This is what makes delegating to a cheaper provider
 * safe — a wrong answer is dropped rather than reverted out of your tree.
 */
export type Isolation = "none" | "worktree";
export const DEFAULT_ISOLATION: Isolation = "none";

/**
 * A deterministic completion gate (P1). When set on a run/phase, the orchestrator's
 * `[[PHASE-COMPLETE]]` is not honored until `cmd` exits 0; a non-zero exit feeds the
 * output back so the agents fix it, and after `maxFailures` consecutive failures the
 * run HALTs (circuit breaker) rather than looping. LLM does the fixing; this decides
 * "done" and breaks the loop deterministically.
 */
/** A soft line (wind down) and a hard line (HALT) on one budget axis. */
export interface Limit {
  soft?: number;
  hard?: number;
}

/**
 * Spend ceilings for a run. `usd` and `tokens` are summed over every seat from
 * the per-turn usage each CLI reports (tokens = everything processed: input,
 * cache reads, cache writes, output). `fiveHourPct` / `sevenDayPct` are the
 * plan windows the claude CLI streams on every turn (`rate_limit_event`,
 * utilization 0–100) — exact for claude seats, invisible to agy seats. At a
 * soft line the orchestrator is told to wind down; at a hard line the run
 * HALTs cleanly and is resumable once the window resets.
 */
export interface BudgetSpec {
  usd?: Limit;
  tokens?: Limit;
  fiveHourPct?: Limit;
  sevenDayPct?: Limit;
}

/** The plan-window utilization a claude turn reports, as md-agent stores it. */
export interface WindowSnapshot {
  /** 0–1 */
  fiveHour?: { utilization: number; resetsAt: number };
  sevenDay?: { utilization: number; resetsAt: number };
  /** ms when observed */
  at: number;
}

export interface VerifySpec {
  /** Shell command; exit 0 = pass. e.g. "npm test", "dotnet build". */
  cmd: string;
  /** Working dir for the command (the target repo, NOT the run dir). Default: process.cwd(). */
  cwd?: string;
  /** Consecutive failures tolerated before the run HALTs. Default 2. */
  maxFailures?: number;
  /** Seconds before the verify command is killed and counted as a failure. Default 600. */
  timeoutSec?: number;
}

export interface RunState {
  goal: string;
  roles: RoleSpec[];
  /** Default auto-heal ladder (see LaunchConfig.fallback); seats read it at heal time. */
  fallback?: FallbackRung | FallbackRung[];
  context?: string;
  /**
   * Set (ISO timestamp) when the user marks the run complete from the home
   * screen. Completed runs are hidden from every home-screen menu. Restoring is
   * deliberately a hand edit — delete this field from the run's state.json —
   * so "complete" is a shelving action, not a destructive one.
   */
  completedAt?: string;
  /** Max minutes between synopsis checkpoints. Persisted so resume keeps the cadence. */
  maxMinutes?: number;
  /** Whether the orchestrator may form sub-teams (1:1 huddles). Chosen at setup. */
  teams?: boolean;
  /**
   * Soft time budget for a run/session, in minutes. Drives the live time signal
   * injected into the orchestrator each turn (elapsed / remaining) and the
   * wind-down nudge once exceeded. Soft by design — over-runs are tolerated to
   * land in-flight work, never a hard stop. Undefined = no budget (elapsed only).
   */
  budgetMinutes?: number;
  /**
   * When true, the orchestrator may END the run itself — emitting
   * `[[PHASE-COMPLETE]]` once the goal is met, every role is idle, and all work
   * is committed — instead of idling until a checkpoint or the budget. Journey
   * phases default this ON so a finished phase hands off immediately; the
   * interactive wizard leaves it off (the run stays alive for more work).
   */
  autoComplete?: boolean;
  /** Deterministic completion gate + circuit breaker (P1). Undefined = no gate. */
  verify?: VerifySpec;
  /** Spend ceilings; see {@link BudgetSpec}. */
  budget?: BudgetSpec;
  /** Journal settings for this run (see journal.ts); merged over the global config. */
  journal?: { remote?: string; autoPush?: boolean; ask?: boolean };
  /** Where role edits land. Default "none" (shared cwd). See {@link Isolation}. */
  isolation?: Isolation;
  /**
   * Escalation tiering (P1c) — requires `verify`. An ordered model-tier ladder the
   * circuit breaker climbs on repeated verify failure: instead of HALTing at
   * `verify.maxFailures`, bump every role to the next tier (fresh, stronger
   * sessions) and retry with the failure context; HALT only once the ladder is
   * exhausted. e.g. ["sonnet","opus"]. Each role keeps its provider; tiers map per
   * provider (claude haiku/sonnet/opus, agy flash-low/flash-medium/pro-low).
   */
  escalation?: ModelTier[];
  /** Set when this run is one phase of a journey — enough to resume it from the home screen. */
  journey?: JourneyRef;
  /** Last successful journal push of this run (see journal.ts). */
  journalPush?: { at: string; remote: string };
  /** Set when this run dir was pulled from the journal repo rather than created here. */
  journalPulledAt?: string;
  /** ISO timestamp of the run's clean teardown; absent while running or after a crash. */
  endedAt?: string;
  /** Why the run ended (the stopAll reason), e.g. "phase complete: …", "user typed exit". */
  endReason?: string;
}

/**
 * Where a journey phase run came from. Persisted into the phase's state.json so
 * the home screen can resume the journey without the user re-typing the
 * manifest path and phase id.
 */
export interface JourneyRef {
  /** Absolute path to the journey manifest. */
  manifest: string;
  name: string;
  phaseId: string;
  /** 0-based index of this phase in the manifest. */
  phaseIndex: number;
  /** Phase count at launch time. */
  total: number;
}

/**
 * A fully-specified run that can be launched WITHOUT the interactive wizard
 * (`--launch <file.json>`). The console UI still runs — this only replaces the
 * setup questions. Anything optional that's omitted (run name, per-role
 * name/model) is filled by the one-time orchestrator bootstrap turn; supply
 * them all and that LLM call is skipped, so the run starts instantly.
 */
export interface LaunchConfig {
  /** kebab run name; doubles as the journey phase id. Omitted → orchestrator invents one. */
  name?: string;
  goal: string;
  roles: RoleSpec[];
  /** Path (relative to the config file) to a context markdown doc — included whole. */
  context?: string;
  /** Path (relative to the config file) to a handshake/inbox doc — prepended as context. */
  inbox?: string;
  maxMinutes?: number;
  teams?: boolean;
  budgetMinutes?: number;
  /** Let the orchestrator end the run itself when the goal is met (see RunState.autoComplete). */
  autoComplete?: boolean;
  /** First event handed to the orchestrator (defaults to "Begin the run."). */
  kickoff?: string;
  /** Explicit run directory; otherwise a timestamped dir under runs/. */
  runDir?: string;
  /** Deterministic completion gate + circuit breaker (P1). */
  verify?: VerifySpec;
  /** Escalation tiering ladder (P1c); requires verify. See RunState.escalation. */
  escalation?: ModelTier[];
  /** Where role edits land. Default "none" (shared cwd). See {@link Isolation}. */
  isolation?: Isolation;
  /** Spend ceilings; see {@link BudgetSpec}. */
  budget?: BudgetSpec;
  /** Default auto-heal ladder for every seat without its own `fallback`. */
  fallback?: FallbackRung | FallbackRung[];
  /** Journal settings for this run, over the global ~/.config/md-agent/config.json. */
  journal?: { remote?: string; autoPush?: boolean; ask?: boolean };
  /** Set by the journey driver; recorded into state.json for home-screen resume. */
  journey?: JourneyRef;
}

export async function readState(runDir: string): Promise<RunState> {
  const raw = await readFile(path.join(runDir, "state.json"), "utf8");
  return JSON.parse(raw) as RunState;
}

/** Read-merge-write state.json so callers can update a single field safely. */
export async function updateState(
  runDir: string,
  patch: Partial<RunState>
): Promise<void> {
  const cur = await readState(runDir);
  const next = { ...cur, ...patch };
  await writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify(next, null, 2),
    "utf8"
  );
}

// -------- session-id persistence --------
// Each participant ("orchestrator" or a role name) writes only its own file,
// so concurrent role processes never race on a shared file.

function sessionFile(runDir: string, who: string): string {
  return path.join(runDir, "sessions", `${who}.txt`);
}

/**
 * Per-participant stream log: every line the agent CLI streamed during each
 * turn, verbatim, bracketed by md-agent turn markers. This is what "look inside
 * a seat" reads — the outbox only ever carries the seat's final status report.
 */
export function logPath(runDir: string, who: string): string {
  return path.join(runDir, "log", `${who}.jsonl`);
}

// -------- plan-window snapshots --------
// Each claude seat writes what its last turn reported; the run's view is the
// freshest one across participants (they all see the same account windows).

function windowFile(runDir: string, who: string): string {
  return path.join(runDir, "sessions", `${who}.window.json`);
}

export async function writeWindow(runDir: string, who: string, w: WindowSnapshot): Promise<void> {
  const file = windowFile(runDir, who);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(w), "utf8");
}

export async function readLatestWindow(runDir: string): Promise<WindowSnapshot | null> {
  const dir = path.join(runDir, "sessions");
  if (!existsSync(dir)) return null;
  let best: WindowSnapshot | null = null;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".window.json")) continue;
    try {
      const w = JSON.parse(await readFile(path.join(dir, name), "utf8")) as WindowSnapshot;
      if (!best || w.at > best.at) best = w;
    } catch {
      // unreadable snapshot — skip
    }
  }
  return best;
}

/** Everything a turn processed: input, cache reads, cache writes, output. */
export function usageTokens(u: Usage | CostRecord): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens + u.outputTokens;
}

/** `in 18 / cache 36k / out 554` — the shape every usage line uses. */
export function formatUsage(u: Usage | CostRecord): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`);
  return `in ${k(u.inputTokens)} / cache ${k(u.cacheReadTokens)}${u.cacheCreationTokens ? `+${k(u.cacheCreationTokens)}w` : ""} / out ${k(u.outputTokens)}`;
}

export async function writeSessionId(
  runDir: string,
  who: string,
  id: string
): Promise<void> {
  const file = sessionFile(runDir, who);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, id.trim(), "utf8");
}

export async function readSessionId(
  runDir: string,
  who: string
): Promise<string | null> {
  const file = sessionFile(runDir, who);
  if (!existsSync(file)) return null;
  const id = (await readFile(file, "utf8")).trim();
  return id.length > 0 ? id : null;
}

/** One session a seat has run on: its generation (0 = first, +1 per recycle), provider and id. */
export interface SessionRecord {
  gen: number;
  provider: Provider;
  id: string;
  at: string;
}

function sessionHistoryFile(runDir: string, who: string): string {
  return path.join(runDir, "sessions", `${who}.sessions.jsonl`);
}

/** Append a seat's session to its lineage; the journal carries this so a pulled run can find the sessions again. */
export async function appendSessionRecord(runDir: string, who: string, rec: SessionRecord): Promise<void> {
  const file = sessionHistoryFile(runDir, who);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(rec) + "\n", "utf8");
}

export async function readSessionRecords(runDir: string, who: string): Promise<SessionRecord[]> {
  const file = sessionHistoryFile(runDir, who);
  if (!existsSync(file)) return [];
  const out: SessionRecord[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionRecord);
    } catch {
      // a torn line — skip
    }
  }
  return out;
}

// -------- token usage + cost accounting --------
// Each participant accumulates its own `sessions/<who>.cost.json`; a run-wide
// total is just the sum across those files. Single-writer-per-file (each
// process only writes its own), so no cross-process write races.

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** Cumulative usage for one participant, with a turn count. */
export interface CostRecord extends Usage {
  turns: number;
}

const ZERO_COST: CostRecord = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turns: 0,
};

function costFile(runDir: string, who: string): string {
  return path.join(runDir, "sessions", `${who}.cost.json`);
}

/** Add one turn's usage to a participant's cumulative cost file; returns the new total. */
export async function recordUsage(
  runDir: string,
  who: string,
  u: Usage
): Promise<CostRecord> {
  const file = costFile(runDir, who);
  let cur: CostRecord = { ...ZERO_COST };
  if (existsSync(file)) {
    try {
      cur = { ...ZERO_COST, ...(JSON.parse(await readFile(file, "utf8")) as CostRecord) };
    } catch {
      // Corrupt/partial file — start fresh rather than crash a long run.
    }
  }
  const next: CostRecord = {
    inputTokens: cur.inputTokens + u.inputTokens,
    outputTokens: cur.outputTokens + u.outputTokens,
    cacheReadTokens: cur.cacheReadTokens + u.cacheReadTokens,
    cacheCreationTokens: cur.cacheCreationTokens + u.cacheCreationTokens,
    costUsd: cur.costUsd + u.costUsd,
    turns: cur.turns + 1,
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next), "utf8");
  return next;
}

/** Cumulative usage for one participant (zeroed if it hasn't recorded a turn yet). */
export async function readCost(runDir: string, who: string): Promise<CostRecord> {
  const file = costFile(runDir, who);
  if (!existsSync(file)) return { ...ZERO_COST };
  try {
    return { ...ZERO_COST, ...(JSON.parse(await readFile(file, "utf8")) as CostRecord) };
  } catch {
    return { ...ZERO_COST };
  }
}

/** Sum every participant's cost file into a single run-wide total. */
export async function readRunCost(runDir: string): Promise<CostRecord> {
  const dir = path.join(runDir, "sessions");
  if (!existsSync(dir)) return { ...ZERO_COST };
  const total: CostRecord = { ...ZERO_COST };
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".cost.json")) continue;
    try {
      const r = JSON.parse(await readFile(path.join(dir, name), "utf8")) as CostRecord;
      total.inputTokens += r.inputTokens ?? 0;
      total.outputTokens += r.outputTokens ?? 0;
      total.cacheReadTokens += r.cacheReadTokens ?? 0;
      total.cacheCreationTokens += r.cacheCreationTokens ?? 0;
      total.costUsd += r.costUsd ?? 0;
      total.turns += r.turns ?? 0;
    } catch {
      // Skip unreadable file.
    }
  }
  return total;
}

// -------- orchestrator ledger (the orchestrator's externalized memory) --------
// The orchestrator runs stateless: each turn it is handed this ledger + the new
// event, and it emits a replacement ledger. The ledger holds the run's working
// state — plan, per-role status, open questions, decisions, and POINTERS to
// files/KB for detail — never raw content. This caps the orchestrator's
// resident context so token cost doesn't grow with the conversation.

export function ledgerPath(runDir: string): string {
  return path.join(runDir, "ledger.md");
}

export async function readLedger(runDir: string): Promise<string> {
  const f = ledgerPath(runDir);
  if (!existsSync(f)) return "";
  return readFile(f, "utf8");
}

export async function writeLedger(runDir: string, content: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(ledgerPath(runDir), content.trim() + "\n", "utf8");
}

// -------- transcript replay (fallback when no session id is stored) --------

export interface TurnBlock {
  tag: string;
  content: string;
}

/**
 * Parse the master transcript into tagged turn blocks.
 *
 * Turn headers are emitted by appendTranscript as `## <tag>` immediately
 * followed by a `_HH:MM:SS_` line (current format) or, in older runs, as
 * `### [<ISO>] <tag>`. Markdown headers *inside* an agent's message lack that
 * signature, so we only treat lines matching it as turn boundaries.
 */
export function parseTranscript(text: string): TurnBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: TurnBlock[] = [];
  let cur: TurnBlock | null = null;
  let skipNext = false;

  const push = () => {
    if (cur) blocks.push({ tag: cur.tag, content: cur.content.trim() });
  };

  for (let i = 0; i < lines.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const line = lines[i];
    const next = lines[i + 1] ?? "";

    const curHeader = /^## (.+?)\s*$/.exec(line);
    if (curHeader && /^_\d{2}:\d{2}:\d{2}_\s*$/.test(next)) {
      push();
      cur = { tag: curHeader[1].trim(), content: "" };
      skipNext = true; // consume the `_time_` line
      continue;
    }

    const oldHeader = /^### \[[^\]]+\]\s*(.+?)\s*$/.exec(line);
    if (oldHeader) {
      push();
      cur = { tag: oldHeader[1].trim(), content: "" };
      continue;
    }

    if (cur) cur.content += line + "\n";
  }
  push();
  return blocks;
}

/** Keep the most recent turns whose joined length stays under maxChars. */
function tailJoin(turns: string[], maxChars: number): string {
  const kept: string[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = turns[i].length + 2;
    if (total + len > maxChars && kept.length > 0) break;
    kept.unshift(turns[i]);
    total += len;
  }
  return kept.join("\n\n");
}

const HISTORY_CHAR_CAP = 60_000;

/**
 * Reconstruct a readable history of a role's prior conversation, to seed a
 * fresh claude session when no stored session id is available.
 */
export function buildRoleHistory(transcriptText: string, roleName: string): string {
  const inTag = `→ ${roleName}`;
  const outTag = `← ${roleName}`;
  const turns: string[] = [];
  let lastIn = "";
  for (const b of parseTranscript(transcriptText)) {
    if (b.tag === inTag) {
      // Orchestrator and role both log `→ role` with identical content; dedupe.
      if (b.content === lastIn) continue;
      lastIn = b.content;
      turns.push(`[orchestrator → you]\n${b.content}`);
    } else if (b.tag === outTag) {
      turns.push(`[you → orchestrator]\n${b.content}`);
    }
  }
  return tailJoin(turns, HISTORY_CHAR_CAP);
}

/**
 * The most recent CHECKPOINT snapshots from a transcript, oldest first. Feeds the
 * journey handshake author mid-phase state the final (aggressively pruned) ledger
 * may have discarded.
 */
export function recentCheckpoints(
  transcriptText: string,
  max = 2,
  capChars = 6000
): string[] {
  const cps = parseTranscript(transcriptText)
    .filter((b) => b.tag === "CHECKPOINT")
    .map((b) => b.content);
  const out: string[] = [];
  let total = 0;
  for (let i = cps.length - 1; i >= 0 && out.length < max; i--) {
    total += cps[i].length;
    if (total > capChars && out.length > 0) break;
    out.unshift(cps[i]);
  }
  return out;
}
