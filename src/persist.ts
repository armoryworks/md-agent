import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

/** Model tiers the orchestrator may assign to a role. */
export type ModelTier = "opus" | "sonnet" | "haiku";

/** Concrete claude model ids per tier. Single source of truth. */
export const MODEL_IDS: Record<ModelTier, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
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

export interface RoleSpec {
  name: string;
  description: string;
  /** Model tier the orchestrator selected for this role. */
  model?: ModelTier;
}

export interface RunState {
  goal: string;
  roles: RoleSpec[];
  context?: string;
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

/** Reconstruct a readable history of the orchestrator's coordination so far. */
export function buildOrchHistory(
  transcriptText: string,
  roleNames: string[]
): string {
  const roleSet = new Set(roleNames);
  const turns: string[] = [];
  let lastDispatch = "";
  for (const b of parseTranscript(transcriptText)) {
    const toM = /^→ (.+)$/.exec(b.tag);
    const fromM = /^← (.+)$/.exec(b.tag);
    if (toM && roleSet.has(toM[1].trim())) {
      const key = `${toM[1].trim()}|${b.content}`;
      if (key === lastDispatch) continue; // dedupe dual-logged dispatch
      lastDispatch = key;
      turns.push(`[you dispatched → ${toM[1].trim()}]\n${b.content}`);
    } else if (fromM && roleSet.has(fromM[1].trim())) {
      turns.push(`[${fromM[1].trim()} → you]\n${b.content}`);
    } else if (b.tag === "USER" || b.tag === "USER INTERJECTION") {
      turns.push(`[user]\n${b.content}`);
    } else if (b.tag === "USER FEEDBACK") {
      turns.push(`[user feedback at a checkpoint]\n${b.content}`);
    } else if (b.tag === "SYNOPSIS") {
      turns.push(`[you gave this synopsis]\n${b.content}`);
    }
  }
  return tailJoin(turns, HISTORY_CHAR_CAP);
}
