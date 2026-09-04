import path from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeSession } from "./claude.js";
import {
  AGY_MODEL_IDS,
  type BudgetSpec,
  type Isolation,
  MODEL_IDS,
  type ModelTier,
  normalizeProvider,
  normalizeTier,
  type RoleSpec,
  type VerifySpec,
} from "./persist.js";
import { Theme, theme as t } from "./theme.js";

const run = promisify(execFile);

/**
 * The planner: hand the user's goal, plus what can be seen of the repo, to a
 * high-tier Claude that knows how md-agent works, and get back a recommended
 * team — how many seats, who does what on which provider and tier, the verify
 * command, isolation, a budget — as a launch config the user can run, save,
 * or adjust. MD_AGENT_PLANNER_MODEL overrides the model.
 */

export const DEFAULT_PLANNER_MODEL = "claude-fable-5-1";

export function resolvePlannerModel(): string {
  const m = process.env.MD_AGENT_PLANNER_MODEL?.trim();
  if (!m) return DEFAULT_PLANNER_MODEL;
  return m in MODEL_IDS ? MODEL_IDS[m as ModelTier] : m;
}

/** What the planner needs to know about the tool it is planning for. */
export const DESIGN_BRIEF = `
md-agent runs a TEAM of agent CLIs against one goal. A stateless ORCHESTRATOR (claude, sonnet tier, no edit tools) holds a ledger and routes work to named ROLE SEATS over files; each seat is its own agent process with its own session. Seats report concise STATUS to the orchestrator (≤250 words) and put real work in files. The orchestrator only coordinates — it cannot edit.

The harness is delegate → isolate → verify → admit:
- DELEGATE: each seat has a provider and a model tier.
  provider "claude": judgement, review, anything that can be quietly wrong, conflicts between docs and code, customer-facing or legal surfaces, the reviewer seat over other seats' output. Tiers: opus (${MODEL_IDS.opus}) deepest reasoning; sonnet (${MODEL_IDS.sonnet}) strong default; haiku (${MODEL_IDS.haiku}) cheap and mechanical.
  provider "agy" (Antigravity/Gemini): breadth and volume behind a verifier — enumeration across many files, extraction to a schema, applying a known change repeatedly, first-pass drafts a command will check. Tiers: opus (${AGY_MODEL_IDS.opus}), sonnet (${AGY_MODEL_IDS.sonnet}), haiku (${AGY_MODEL_IDS.haiku}). Content goes to Google: never for health, client, or confidential data. An agreeable wrong answer is its expensive failure, so it needs a verify command or a claude reviewer behind it.
  The split that matters is NOT smart-vs-cheap: it is whether the work has a cheap, complete CHECK. Where a command can prove the result, delegate; where the only check is judgement, keep it on claude.
- ISOLATE: isolation "worktree" gives every seat its own git worktree and branch; nothing lands in the user's tree until they merge. Requires the target to be a git repo. "none" = seats edit the shared tree directly (only when seats are advisory or fully trusted).
- VERIFY: a shell command (exit 0 = pass) — tests, build, lint, a grep. Every seat reply is checked in that seat's workspace; a seat that claims done while it fails gets the output straight back. The run only completes when every changed workspace passes. maxFailures (default 2) is the circuit breaker; an escalation ladder (e.g. ["sonnet","opus"]) promotes seats on repeated failure, except seats pinned with escalate:false — pin deliberately cheap seats so a failure elsewhere does not erase the cost split.
- ADMIT: the user merges the branches that passed.
Seats that edit files need permissionMode "acceptEdits"; seats that must run commands need "bypassPermissions" (headless agents cannot prompt). Budgets: usd / tokens / plan-window percentages, each with soft (wind down) and hard (halt) lines. Checkpoints every maxMinutes let the user steer. Sub-team huddles (teams:true) let two seats iterate 1:1 without the orchestrator in the loop.

Cost intuition: every seat reply costs an orchestrator turn; more seats means more coordination. Two to four seats is typical; one seat plus a reviewer is common; six or more needs a genuinely parallel goal. A reviewer seat is worth it whenever the work can be quietly wrong. Prefer fewer, sharper seats with a verify command over many seats with none.
`.trim();

export interface TeamPlan {
  name: string;
  summary: string;
  roles: RoleSpec[];
  verify?: VerifySpec;
  isolation: Isolation;
  budget?: BudgetSpec;
  escalation?: ModelTier[];
  maxMinutes: number;
  teams: boolean;
  rationale: string[];
  /** Things the planner could not decide from the goal + repo alone. */
  openQuestions: string[];
}

/** A quick look at the repo so the planner can propose a real verify command. */
async function repoFacts(cwd: string): Promise<string> {
  const lines: string[] = [];
  try {
    const entries = (await readdir(cwd)).filter((e) => !e.startsWith(".") || e === ".github").sort();
    lines.push(`Top-level entries (${entries.length}): ${entries.slice(0, 60).join(", ")}${entries.length > 60 ? ", …" : ""}`);
  } catch {
    lines.push("Top-level: (unreadable)");
  }
  try {
    lines.push(`git remote: ${(await run("git", ["remote", "get-url", "origin"], { cwd })).stdout.trim()}`);
    const status = (await run("git", ["status", "--porcelain"], { cwd })).stdout.trim();
    lines.push(`git: repo, ${status ? `${status.split("\n").length} uncommitted change(s)` : "clean"}`);
  } catch {
    lines.push("git: not a repository (worktree isolation unavailable)");
  }
  const pkg = path.join(cwd, "package.json");
  if (existsSync(pkg)) {
    try {
      const p = JSON.parse(await readFile(pkg, "utf8"));
      lines.push(`package.json scripts: ${Object.keys(p.scripts ?? {}).join(", ") || "(none)"}`);
    } catch {
      // ignore
    }
  }
  for (const marker of ["Makefile", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "docker-compose.yml"]) {
    if (existsSync(path.join(cwd, marker))) lines.push(`present: ${marker}`);
  }
  try {
    const cs = (await readdir(cwd)).filter((e) => /\.(sln|csproj)$/.test(e));
    if (cs.length) lines.push(`dotnet: ${cs.join(", ")}`);
  } catch {
    // ignore
  }
  return lines.join("\n");
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? text.slice(a, b + 1) : text;
}

const OUTPUT_CONTRACT = `
Reply with ONE JSON object and nothing else — no preamble, no fence:
{
  "name": "kebab-case run name, 2–4 words",
  "summary": "one sentence: the team and why this shape",
  "roles": [
    { "name": "kebab-name", "description": "what this seat owns and how it reports", "provider": "claude|agy",
      "model": "opus|sonnet|haiku", "permissionMode": "acceptEdits|bypassPermissions|plan", "escalate": true|false }
  ],
  "verify": { "cmd": "shell command, exit 0 = pass", "maxFailures": 2, "timeoutSec": 600 } | null,
  "isolation": "worktree|none",
  "escalation": ["sonnet","opus"] | null,
  "budget": { "usd": { "soft": 5, "hard": 15 } } | null,
  "maxMinutes": 15,
  "teams": false,
  "rationale": ["short bullets: why this many seats, why each provider/tier, why this verify command"],
  "openQuestions": ["anything the goal or repo leaves undecided that the user should settle before launching"]
}
Rules: propose the FEWEST seats that cover the goal; include a claude reviewer when work can be quietly wrong; a verify command only if one can actually prove the result here (else null and say so in openQuestions); isolation "worktree" whenever the target is a git repo and seats edit files; pin agy seats with escalate:false; never put confidential or health data on agy.
`.trim();

/** Ask the planner for a team. Reads the repo (read-only tools) to ground the verify command. */
export async function planTeam(goal: string, opts: { cwd?: string; model?: string } = {}): Promise<{ plan: TeamPlan; raw: string; costUsd: number }> {
  const cwd = opts.cwd ?? process.cwd();
  const facts = await repoFacts(cwd);
  const session = new ClaudeSession({
    systemPrompt: [
      "You plan agent teams for md-agent. You know how it works:",
      "",
      DESIGN_BRIEF,
      "",
      "You may read the repository you are run in (read-only tools) to find how it is built and tested — do so briefly when it decides the verify command. Do not edit anything.",
      "",
      OUTPUT_CONTRACT,
    ].join("\n"),
    model: opts.model ?? resolvePlannerModel(),
    stateless: true,
    cwd,
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
  });
  const raw = await session.send(["GOAL:", goal.trim(), "", "REPOSITORY:", facts].join("\n"));
  const costUsd = session.lastUsage?.costUsd ?? 0;
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (e) {
    throw new Error(`planner did not return JSON (${(e as Error).message}):\n${raw.slice(0, 800)}`);
  }
  const roles: RoleSpec[] = (Array.isArray(parsed.roles) ? parsed.roles : []).map((r: any, i: number) => ({
    name: String(r.name ?? `role-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `role-${i + 1}`,
    description: String(r.description ?? "").trim(),
    provider: normalizeProvider(r.provider),
    model: typeof r.model === "string" && r.model in MODEL_IDS ? normalizeTier(r.model) : normalizeTier(undefined),
    permissionMode: typeof r.permissionMode === "string" ? r.permissionMode : "acceptEdits",
    ...(r.escalate === false ? { escalate: false } : {}),
  }));
  if (!roles.length) throw new Error("planner proposed no seats");
  const plan: TeamPlan = {
    name: String(parsed.name ?? "planned-run"),
    summary: String(parsed.summary ?? ""),
    roles,
    verify: parsed.verify && typeof parsed.verify.cmd === "string" ? { cmd: parsed.verify.cmd, maxFailures: parsed.verify.maxFailures ?? 2, timeoutSec: parsed.verify.timeoutSec ?? 600 } : undefined,
    isolation: parsed.isolation === "none" ? "none" : "worktree",
    budget: parsed.budget && typeof parsed.budget === "object" ? parsed.budget : undefined,
    escalation: Array.isArray(parsed.escalation) ? parsed.escalation.filter((x: unknown) => typeof x === "string" && x in MODEL_IDS) : undefined,
    maxMinutes: Number(parsed.maxMinutes) > 0 ? Math.round(Number(parsed.maxMinutes)) : 15,
    teams: parsed.teams === true,
    rationale: Array.isArray(parsed.rationale) ? parsed.rationale.map(String) : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map(String) : [],
  };
  return { plan, raw, costUsd };
}

/** The plan, for a human to read before deciding. */
export function renderPlan(plan: TeamPlan, costUsd: number, theme: Theme = t): string {
  const dim = (s: string) => theme.paint(s, "dim");
  const out: string[] = [];
  out.push(`${theme.paint("◆", "amber", true)} ${theme.bold(plan.name)}  ${dim(`planned for $${costUsd.toFixed(2)}`)}`);
  if (plan.summary) out.push(`  ${plan.summary}`);
  out.push("");
  out.push(theme.bold(`  ${plan.roles.length} seat${plan.roles.length === 1 ? "" : "s"}`));
  for (const r of plan.roles) {
    const prov = theme.paint(r.provider ?? "claude", r.provider === "agy" ? "amberDark" : "tealDark");
    out.push(`  ${theme.paint("●", "teal")} ${theme.bold(r.name)}  ${prov} ${dim("·")} ${theme.paint(String(r.model), "muted")}${r.escalate === false ? dim(" · pinned") : ""}${r.permissionMode ? dim(` · ${r.permissionMode}`) : ""}`);
    out.push(`      ${dim(r.description)}`);
  }
  out.push("");
  out.push(`  ${theme.bold("verify")}     ${plan.verify ? plan.verify.cmd : theme.paint("none — nothing here can prove the result; the reviewer is the check", "amber")}`);
  out.push(`  ${theme.bold("isolation")}  ${plan.isolation}${plan.isolation === "worktree" ? dim(" — each seat on its own branch; merge what passes") : ""}`);
  if (plan.escalation?.length) out.push(`  ${theme.bold("escalation")} ${plan.escalation.join(" → ")}`);
  if (plan.budget) out.push(`  ${theme.bold("budget")}     ${JSON.stringify(plan.budget)}`);
  out.push(`  ${theme.bold("checkpoint")} every ${plan.maxMinutes} min${plan.teams ? dim(" · huddles allowed") : ""}`);
  if (plan.rationale.length) {
    out.push("");
    out.push(theme.bold("  why"));
    for (const r of plan.rationale) out.push(`  ${dim("·")} ${r}`);
  }
  if (plan.openQuestions.length) {
    out.push("");
    out.push(theme.paint("  settle before launching", "amber", true));
    for (const q of plan.openQuestions) out.push(`  ${theme.paint("?", "amber")} ${q}`);
  }
  return out.join("\n");
}
