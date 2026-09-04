import path from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { checkbox, confirm, select } from "@inquirer/prompts";
import { resumeOrchestrator, runFromConfig, runOrchestrator } from "./orchestrator.js";
import { LAUNCH_FILE } from "./init.js";
import { listSeats, renderSeatLog, showInPager } from "./inspect.js";
import { nextPhase, phaseRunDir, readJourney, runJourney, type Journey } from "./journey.js";
import {
  type JourneyRef,
  readLedger,
  readRunCost,
  readState,
  updateState,
} from "./persist.js";
import { theme as t } from "./theme.js";

/**
 * The home screen: what a bare `md-agent` lands on. Scans `runs/` for prior
 * work and offers the natural verbs — continue the latest thing, resume a
 * specific run, look inside a seat, start new, combine prior runs, shelve or
 * restore. All the CLI flags still exist for scripting; this is the path a
 * human takes, and it should never send them to the filesystem.
 */

const dim = (s: string) => t.paint(s, "dim");
const bold = (s: string) => t.bold(s);

function termWidth(): number {
  return Math.max(40, Math.min(110, (process.stdout.columns ?? 80) - 2));
}

function rule(width = termWidth()): string {
  return dim("─".repeat(width));
}

function banner(subtitle: string): void {
  const shield = t.shield();
  console.log("");
  console.log(` ${shield[0]}  ${t.wordmark()}`);
  console.log(` ${shield[1]}  ${dim("a team of agents on one goal — delegate, isolate, verify, admit")}`);
  console.log(` ${shield[2]}  ${dim(subtitle)}`);
  console.log("");
}

// ---------- run discovery ----------

export type RunStatus = "running" | "complete" | "halted" | "unfinished";

export interface RunSummary {
  dir: string;
  name: string; // basename of the run dir
  goal: string;
  roleCount: number;
  mtimeMs: number;
  costUsd: number;
  status: RunStatus;
  endReason?: string;
  completedAt?: string;
  /** Journey name when the dir was created by the journey driver, else null. */
  journey: string | null;
  /** `NN-phase-id` when part of a journey, else null. */
  phaseId: string | null;
  journeyRef?: JourneyRef;
}

/** One selectable row: a standalone run, or a journey grouping its phase runs. */
export interface Entry {
  key: string;
  label: string;
  runs: RunSummary[];
  isJourney: boolean;
  mtimeMs: number;
}

const JOURNEY_DIR_RE = /^journey-(.+)-(\d{2}-.+)$/;

/** A heartbeat touched within the last minute means a process is still driving this run. */
async function looksLive(dir: string): Promise<boolean> {
  const sessions = path.join(dir, "sessions");
  if (!existsSync(sessions)) return false;
  const now = Date.now();
  for (const f of await readdir(sessions)) {
    if (!f.endsWith(".heartbeat")) continue;
    try {
      if (now - (await stat(path.join(sessions, f))).mtimeMs < 60_000) return true;
    } catch {
      // gone between readdir and stat
    }
  }
  return false;
}

export async function scanRuns(baseDir: string): Promise<RunSummary[]> {
  if (!existsSync(baseDir)) return [];
  const out: RunSummary[] = [];
  for (const name of await readdir(baseDir)) {
    const dir = path.join(baseDir, name);
    try {
      const state = await readState(dir);
      let mtimeMs = (await stat(dir)).mtimeMs;
      for (const f of ["transcript.md", "ledger.md"]) {
        try {
          mtimeMs = Math.max(mtimeMs, (await stat(path.join(dir, f))).mtimeMs);
        } catch {
          // file absent — fine
        }
      }
      const halted = existsSync(path.join(dir, "HALT.txt"));
      const status: RunStatus = halted
        ? "halted"
        : state.endedAt
          ? "complete"
          : (await looksLive(dir))
            ? "running"
            : "unfinished";
      const m = JOURNEY_DIR_RE.exec(name);
      out.push({
        dir,
        name,
        goal: state.goal ?? "(no goal recorded)",
        roleCount: state.roles?.length ?? 0,
        mtimeMs,
        costUsd: (await readRunCost(dir)).costUsd,
        status,
        endReason: state.endReason,
        completedAt: state.completedAt,
        journey: state.journey?.name ?? (m ? m[1] : null),
        phaseId: m ? m[2] : (state.journey ? `${String(state.journey.phaseIndex).padStart(2, "0")}-${state.journey.phaseId}` : null),
        journeyRef: state.journey,
      });
    } catch {
      // not a run dir (or unreadable) — skip silently
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Group journey phase runs under one entry; standalone runs are their own. */
export function toEntries(runs: RunSummary[]): Entry[] {
  const journeys = new Map<string, RunSummary[]>();
  const entries: Entry[] = [];
  for (const r of runs) {
    if (r.journey) {
      const list = journeys.get(r.journey) ?? [];
      list.push(r);
      journeys.set(r.journey, list);
    } else {
      entries.push({ key: r.dir, label: r.name, runs: [r], isJourney: false, mtimeMs: r.mtimeMs });
    }
  }
  for (const [name, list] of journeys) {
    list.sort((a, b) => (a.phaseId ?? "").localeCompare(b.phaseId ?? ""));
    entries.push({
      key: `journey:${name}`,
      label: `journey "${name}"`,
      runs: list,
      isJourney: true,
      mtimeMs: Math.max(...list.map((r) => r.mtimeMs)),
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

// ---------- journey resolution ----------

interface JourneyPlan {
  manifest: string;
  journey: Journey;
  /** Phase to pick up at, or null when every phase is complete. */
  next: { index: number; id: string; status: string } | null;
}

/** Work out where a journey stands from the manifest its phase runs recorded. */
async function planJourney(e: Entry): Promise<JourneyPlan | { error: string }> {
  const ref = e.runs.map((r) => r.journeyRef).find(Boolean);
  if (!ref) {
    return { error: "this journey predates manifest tracking — resume one of its phases directly, or run --journey <manifest> --from <phase>" };
  }
  if (!existsSync(ref.manifest)) {
    return { error: `its manifest is gone: ${ref.manifest}` };
  }
  let journey: Journey;
  try {
    journey = await readJourney(ref.manifest);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const np = await nextPhase(journey);
  return {
    manifest: ref.manifest,
    journey,
    next: np ? { index: np.index, id: journey.phases[np.index].id, status: np.status } : null,
  };
}

// ---------- rendering ----------

function timeAgo(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function ellipsize(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

function statusTag(status: RunStatus): string {
  switch (status) {
    case "running":
      return t.paint("● running", "amber", true);
    case "halted":
      return t.paint("▲ HALTED", "red", true);
    case "unfinished":
      return t.paint("◐ unfinished", "teal");
    default:
      return t.paint("✔ complete", "green");
  }
}

export function entryStatus(e: Entry): RunStatus {
  if (e.runs.some((r) => r.status === "running")) return "running";
  if (e.runs.some((r) => r.status === "halted")) return "halted";
  if (e.runs.some((r) => r.status === "unfinished")) return "unfinished";
  return "complete";
}

function renderEntry(e: Entry): string {
  const glyph = e.isJourney ? t.paint("◆", "amber") : t.paint("●", "teal");
  const cost = e.runs.reduce((s, r) => s + r.costUsd, 0);
  const meta = [
    `$${cost.toFixed(2)}`,
    timeAgo(e.mtimeMs),
    e.isJourney ? `${e.runs.length} phase${e.runs.length === 1 ? "" : "s"}` : `${e.runs[0].roleCount} seats`,
  ].join(" · ");
  const goal = ellipsize(e.runs[0].goal, Math.max(20, termWidth() - 8));
  const lines = [` ${glyph} ${bold(e.label)}  ${statusTag(entryStatus(e))}`, `     ${dim(goal)}`, `     ${dim(meta)}`];
  if (e.isJourney) {
    for (const r of e.runs) lines.push(`       ${dim("└")} ${dim(r.phaseId ?? r.name)}  ${statusTag(r.status)}`);
  }
  return lines.join("\n");
}

function renderHome(entries: Entry[], hiddenRuns: number): void {
  banner(`workspace: ${process.cwd()}`);
  if (entries.length === 0) {
    console.log(
      hiddenRuns > 0
        ? ` ${dim(`no active work here — ${hiddenRuns} completed run(s) shelved in runs/`)}`
        : ` ${dim("no prior runs found in ./runs — let's start something")}`
    );
  } else {
    console.log(bold(" Recent work"));
    console.log(rule());
    for (const e of entries) console.log(renderEntry(e));
    console.log(rule());
    if (hiddenRuns > 0) console.log(` ${dim(`(+${hiddenRuns} shelved run(s) — "Restore" brings one back)`)}`);
  }
  console.log("");
}

// ---------- actions ----------

const BACK = Symbol("back");

async function pickRun(runs: RunSummary[], message: string): Promise<RunSummary | typeof BACK> {
  return select<RunSummary | typeof BACK>({
    message,
    pageSize: 12,
    choices: [
      ...runs.map((r) => ({
        name: `${r.name}  ${statusTag(r.status)}  ${dim(`· $${r.costUsd.toFixed(2)} · ${timeAgo(r.mtimeMs)}`)}`,
        value: r,
        description: ellipsize(r.goal, 100),
      })),
      { name: dim("← back"), value: BACK },
    ],
  });
}

/** Continue an entry: a journey at its next phase, a run where it stopped. */
async function continueEntry(e: Entry): Promise<boolean> {
  if (!e.isJourney) {
    await resumeOrchestrator(e.runs[0].dir);
    return true;
  }
  const plan = await planJourney(e);
  if ("error" in plan) {
    console.log(` ${t.paint("!", "amber", true)} can't drive ${e.label} automatically — ${plan.error}`);
    const run = await pickRun(e.runs, "Resume which phase directly?");
    if (run === BACK) return false;
    await resumeOrchestrator(run.dir);
    return true;
  }
  if (!plan.next) {
    console.log(` ${t.paint("✔", "green", true)} ${e.label} is complete — every phase ended cleanly.`);
    return false;
  }
  const { index, id, status } = plan.next;
  const verb = status === "halted" ? "retry halted" : status === "unfinished" ? "resume" : "start";
  console.log(
    ` ${t.paint("▸", "amber", true)} ${e.label}: ${verb} phase ${index + 1}/${plan.journey.phases.length} ${bold(id)}` +
      (status === "halted" ? dim(`  (HALT reason in ${path.relative(process.cwd(), phaseRunDir(plan.journey.name, index, id))}/HALT.txt — cleared on resume)`) : "")
  );
  await runJourney(plan.manifest, { from: id });
  return true;
}

/** Build the seed-context doc a combined run starts from. */
async function buildCombinedContext(runs: RunSummary[]): Promise<string> {
  const parts: string[] = [
    "# Context carried over from prior md-agent runs",
    "",
    "You are continuing work that spans the prior runs below. Their final ledgers are the",
    "authoritative state of what each achieved; their transcripts and artifacts remain on",
    "disk at the paths given — read them on demand rather than re-deriving.",
  ];
  for (const r of runs) {
    const ledger = (await readLedger(r.dir)).trim();
    parts.push(
      "",
      `## Prior run: ${r.name}`,
      `- Goal: ${r.goal}`,
      `- Run dir (transcript.md, artifacts): ${path.resolve(r.dir)}`,
      r.status === "halted" ? "- NOTE: this run HALTED (see HALT.txt in its dir) — its work may be unfinished." : "",
      "",
      "Final ledger:",
      ledger ? ledger.slice(0, 4000) + (ledger.length > 4000 ? "\n…[truncated — full ledger in the run dir]" : "") : "(empty ledger)"
    );
  }
  return parts.filter((l) => l !== "").join("\n");
}

async function inspectRun(runs: RunSummary[]): Promise<void> {
  const run = await pickRun(runs, "Look inside which run?");
  if (run === BACK) return;
  for (;;) {
    const seats = await listSeats(run.dir);
    const who = await select<string | typeof BACK>({
      message: `${run.name} — which seat?`,
      choices: [
        ...seats.map((s) => ({
          name: `${s.name}${s.hasLog ? "" : dim("  (no trace yet)")}`,
          value: s.name,
        })),
        { name: dim("← back"), value: BACK },
      ],
    });
    if (who === BACK) return;
    showInPager(await renderSeatLog(run.dir, who));
  }
}

/** What a user should know after shelving runs: where the outputs are. */
function printCompletionNotes(entries: Entry[]): void {
  console.log("");
  console.log(t.paint(" ✔ shelved", "green", true) + dim(" — hidden from these menus. Nothing was deleted; \"Restore\" brings it back."));
  for (const e of entries) {
    console.log(` ${bold(e.label)}`);
    for (const r of e.runs) {
      console.log(`   ${t.paint("outputs", "teal")}  ${path.resolve(r.dir)}/`);
      console.log(`            ${dim("transcript.md · ledger.md · log/<seat>.jsonl (traces) · sessions/*.cost.json · workspaces/ (branches)")}`);
    }
  }
  console.log("");
}

// ---------- the loop ----------

export async function runHome(): Promise<void> {
  for (;;) {
    const all = await scanRuns("runs");
    const active = all.filter((r) => !r.completedAt);
    const shelved = all.filter((r) => r.completedAt);
    const entries = toEntries(active);
    const launchFile = path.join(process.cwd(), LAUNCH_FILE);
    const hasLaunch = existsSync(launchFile);

    renderHome(entries, shelved.length);

    const continuable = entries.find((e) => entryStatus(e) !== "complete" && entryStatus(e) !== "running");
    const choices: { name: string; value: string; description?: string }[] = [];
    if (continuable) {
      const st = entryStatus(continuable);
      choices.push({
        name: `▸ Continue ${continuable.label}  ${statusTag(st)}`,
        value: "continue",
        description: continuable.isJourney
          ? "pick the journey up at its first unfinished phase — halted phases are retried"
          : "resume this run where it stopped (its seats reattach to their sessions)",
      });
    }
    if (hasLaunch) {
      choices.push({ name: `▶ Launch ${LAUNCH_FILE}`, value: "launch", description: "start a run from the config in this directory (no wizard)" });
    }
    if (entries.length > 0) {
      choices.push({ name: "↻ Resume a specific run or phase", value: "resume", description: "choose exactly which run to pick up" });
      choices.push({ name: "🔍 Look inside a seat", value: "inspect", description: "a seat's trace: what it was asked, the tools it ran, what it said, what it cost" });
    }
    choices.push({ name: "✦ Start something new", value: "new", description: "the setup wizard: seats, goal, checkpoints" });
    if (active.length > 0) {
      choices.push({ name: "⧉ Combine past runs into a new run", value: "combine", description: "seed a fresh run with the final state of one or more prior runs" });
      choices.push({ name: "✔ Mark runs complete", value: "complete", description: "shelve finished work — hidden from these menus, untouched on disk" });
    }
    if (shelved.length > 0) {
      choices.push({ name: "↺ Restore a shelved run", value: "restore", description: "bring a shelved run back into these menus" });
    }
    if (!hasLaunch) {
      choices.push({ name: dim("⚙ Write a starter launch config (init)"), value: "init", description: `drops ${LAUNCH_FILE} here so the next run skips the wizard` });
    }
    choices.push({ name: dim("Exit"), value: "exit" });

    const action = await select({ message: "What next?", choices });

    if (action === "exit") return;

    if (action === "continue" && continuable) {
      if (await continueEntry(continuable)) return;
      continue;
    }

    if (action === "launch") {
      await runFromConfig(launchFile);
      return;
    }

    if (action === "new") {
      await runOrchestrator({});
      return;
    }

    if (action === "resume") {
      const flat = entries.flatMap((e) => e.runs);
      const journeyRows = entries.filter((e) => e.isJourney);
      const choice = await select<Entry | RunSummary | typeof BACK>({
        message: "Resume what?",
        pageSize: 14,
        choices: [
          ...journeyRows.map((e) => ({
            name: `◆ ${e.label} — drive it from its next phase  ${statusTag(entryStatus(e))}`,
            value: e as Entry | RunSummary,
          })),
          ...flat.map((r) => ({
            name: `${r.journey ? "  └ " : "● "}${r.name}  ${statusTag(r.status)}  ${dim(`· $${r.costUsd.toFixed(2)} · ${timeAgo(r.mtimeMs)}`)}`,
            value: r as Entry | RunSummary,
            description: ellipsize(r.goal, 100),
          })),
          { name: dim("← back"), value: BACK },
        ],
      });
      if (choice === BACK) continue;
      if ("isJourney" in choice) {
        if (await continueEntry(choice)) return;
        continue;
      }
      await resumeOrchestrator(choice.dir);
      return;
    }

    if (action === "inspect") {
      await inspectRun(entries.flatMap((e) => e.runs));
      continue;
    }

    if (action === "init") {
      const { runInit } = await import("./init.js");
      await runInit();
      continue;
    }

    if (action === "combine") {
      const flat = entries.flatMap((e) => e.runs);
      const picked = await checkbox<RunSummary>({
        message: "Combine which runs? (space to select, enter to confirm)",
        pageSize: 12,
        choices: flat.map((r) => ({ name: `${r.name}  ${dim(`· ${ellipsize(r.goal, 60)}`)}`, value: r })),
        validate: (items) => items.length > 0 || "pick at least one run (esc/ctrl-c to cancel)",
      });
      console.log(dim(` seeding a new run with the final state of ${picked.length} prior run(s)…`));
      await runOrchestrator({ contextContent: await buildCombinedContext(picked) });
      return;
    }

    if (action === "complete") {
      const picked = await checkbox<Entry>({
        message: "Mark which as complete? (journeys shelve all their phases)",
        pageSize: 12,
        choices: entries.map((e) => ({ name: e.label, value: e })),
        validate: (items) => items.length > 0 || "pick at least one (esc/ctrl-c to cancel)",
      });
      const runCount = picked.reduce((n, e) => n + e.runs.length, 0);
      const ok = await confirm({ message: `Shelve ${runCount} run(s)? (hidden from menus; nothing deleted; restorable from here)`, default: true });
      if (!ok) continue;
      const stamp = new Date().toISOString();
      for (const e of picked) for (const r of e.runs) await updateState(r.dir, { completedAt: stamp });
      printCompletionNotes(picked);
      continue;
    }

    if (action === "restore") {
      const picked = await checkbox<RunSummary>({
        message: "Restore which shelved run(s)?",
        pageSize: 12,
        choices: shelved.map((r) => ({ name: `${r.name}  ${dim(`· ${ellipsize(r.goal, 60)} · shelved ${timeAgo(Date.parse(r.completedAt!))}`)}`, value: r })),
        validate: (items) => items.length > 0 || "pick at least one (esc/ctrl-c to cancel)",
      });
      for (const r of picked) await updateState(r.dir, { completedAt: undefined });
      console.log(` ${t.paint("↺ restored", "teal", true)} ${picked.map((r) => r.name).join(", ")}`);
      continue;
    }
  }
}

/** Entry point wrapper: a ctrl-c inside a prompt is a normal way to leave. */
export async function runHomeSafe(): Promise<void> {
  try {
    await runHome();
  } catch (e) {
    if (e instanceof Error && e.name === "ExitPromptError") {
      console.log(dim("\nbye.\n"));
      return;
    }
    throw e;
  }
}

