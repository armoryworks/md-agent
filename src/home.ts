import path from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { checkbox, confirm, select } from "@inquirer/prompts";
import { resumeOrchestrator, runOrchestrator } from "./orchestrator.js";
import {
  readLedger,
  readRunCost,
  readState,
  updateState,
} from "./persist.js";

/**
 * The home screen: what a bare `md-agent` lands on. Scans `runs/` for prior
 * work and offers the natural verbs — resume, start new, combine prior runs
 * into a new one, or mark runs complete (shelved: hidden from these menus, on
 * disk untouched). All the CLI flags still exist for scripting; this is the
 * path a human takes.
 */

// ---------- tiny style kit (matches dashboard.ts: raw ANSI, NO_COLOR aware) ----------

const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint =
  (code: string) =>
  (s: string): string =>
    USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = paint("1");
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const yellow = paint("33");
const red = paint("31;1");
const magenta = paint("35");

function rule(width = termWidth()): string {
  return dim("─".repeat(width));
}

function termWidth(): number {
  return Math.max(40, Math.min(100, (process.stdout.columns ?? 80) - 2));
}

function banner(subtitle: string): void {
  const w = termWidth();
  let title = " md-agent · a team of claude agents on one goal ";
  if (title.length > w - 2) title = title.slice(0, w - 3) + " ";
  const pad = Math.max(0, w - title.length - 2);
  console.log("");
  console.log(dim("┌") + dim("─".repeat(w - 2)) + dim("┐"));
  console.log(dim("│") + bold(cyan(title)) + " ".repeat(pad) + dim("│"));
  console.log(dim("└") + dim("─".repeat(w - 2)) + dim("┘"));
  if (subtitle) console.log(` ${dim(subtitle)}`);
  console.log("");
}

// ---------- run discovery ----------

export interface RunSummary {
  dir: string;
  name: string; // basename of the run dir
  goal: string;
  roleCount: number;
  mtimeMs: number;
  costUsd: number;
  halted: boolean;
  completedAt?: string;
  /** Journey name when the dir was created by the journey driver, else null. */
  journey: string | null;
  /** `NN-phase-id` when part of a journey, else null. */
  phaseId: string | null;
}

/** One selectable row: a standalone run, or a journey grouping its phase runs. */
interface Entry {
  key: string;
  label: string;
  runs: RunSummary[];
  isJourney: boolean;
  mtimeMs: number;
}

const JOURNEY_DIR_RE = /^journey-(.+)-(\d{2}-.+)$/;

async function scanRuns(baseDir: string): Promise<RunSummary[]> {
  if (!existsSync(baseDir)) return [];
  const out: RunSummary[] = [];
  for (const name of await readdir(baseDir)) {
    const dir = path.join(baseDir, name);
    try {
      const state = await readState(dir);
      // Recency = the freshest trace of actual work, not the dir's ctime.
      let mtimeMs = (await stat(dir)).mtimeMs;
      for (const f of ["transcript.md", "ledger.md"]) {
        try {
          mtimeMs = Math.max(mtimeMs, (await stat(path.join(dir, f))).mtimeMs);
        } catch {
          // file absent — fine
        }
      }
      const m = JOURNEY_DIR_RE.exec(name);
      out.push({
        dir,
        name,
        goal: state.goal ?? "(no goal recorded)",
        roleCount: state.roles?.length ?? 0,
        mtimeMs,
        costUsd: (await readRunCost(dir)).costUsd,
        halted: existsSync(path.join(dir, "HALT.txt")),
        completedAt: state.completedAt,
        journey: m ? m[1] : null,
        phaseId: m ? m[2] : null,
      });
    } catch {
      // not a run dir (or unreadable) — skip silently
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Group journey phase runs under one entry; standalone runs are their own. */
function toEntries(runs: RunSummary[]): Entry[] {
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
      label: `journey "${name}" (${list.length} phase${list.length === 1 ? "" : "s"})`,
      runs: list,
      isJourney: true,
      mtimeMs: Math.max(...list.map((r) => r.mtimeMs)),
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
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

function renderEntry(e: Entry): string {
  const glyph = e.isJourney ? magenta("◆") : green("●");
  const cost = e.runs.reduce((t, r) => t + r.costUsd, 0);
  const halted = e.runs.some((r) => r.halted);
  const meta = [
    `$${cost.toFixed(2)}`,
    timeAgo(e.mtimeMs),
    e.isJourney ? `${e.runs.length} phases` : `${e.runs[0].roleCount} roles`,
  ].join(" · ");
  const goal = ellipsize(e.runs[0].goal, Math.max(20, termWidth() - 46));
  return ` ${glyph} ${bold(e.label)}${halted ? ` ${red("[HALTED]")}` : ""}\n     ${dim(goal)}\n     ${dim(meta)}`;
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
    if (hiddenRuns > 0) {
      console.log(` ${dim(`(+${hiddenRuns} completed run(s) hidden — restorable, see below when completing)`)}`);
    }
  }
  console.log("");
}

// ---------- actions ----------

const BACK = Symbol("back");

async function pickRun(entries: Entry[], message: string): Promise<RunSummary | typeof BACK> {
  // Journeys resume per-phase (each phase is an ordinary, resumable run).
  const flat = entries.flatMap((e) => e.runs);
  const choice = await select<RunSummary | typeof BACK>({
    message,
    pageSize: 12,
    choices: [
      ...flat.map((r) => ({
        name: `${r.name}${r.halted ? " [HALTED]" : ""}  ${dim(`· $${r.costUsd.toFixed(2)} · ${timeAgo(r.mtimeMs)}`)}`,
        value: r,
        description: ellipsize(r.goal, 100),
      })),
      { name: dim("← back"), value: BACK },
    ],
  });
  return choice;
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
      r.halted ? "- NOTE: this run HALTED (see HALT.txt in its dir) — its work may be unfinished." : "",
      "",
      "Final ledger:",
      ledger ? ledger.slice(0, 4000) + (ledger.length > 4000 ? "\n…[truncated — full ledger in the run dir]" : "") : "(empty ledger)"
    );
  }
  return parts.filter((l) => l !== "").join("\n");
}

/** Everything a user should know after shelving runs: outputs + how to undo. */
function printCompletionNotes(entries: Entry[]): void {
  console.log("");
  console.log(green(" ✔ marked complete") + dim(" — hidden from these menus from now on. Nothing was deleted."));
  console.log("");
  for (const e of entries) {
    console.log(` ${bold(e.label)}`);
    for (const r of e.runs) {
      console.log(`   ${cyan("outputs")}  ${path.resolve(r.dir)}/`);
      console.log(
        `            ${dim("transcript.md (full conversation) · ledger.md (final state) · sessions/*.cost.json (spend) · teams/ (huddles) · spill/ (oversized replies)")}`
      );
      console.log(`   ${yellow("restore")}  delete the ${bold('"completedAt"')} line from ${path.resolve(r.dir)}/state.json`);
    }
    if (e.isJourney) {
      console.log(
        `   ${dim(`journey tip: after restoring, resume mid-journey with  md-agent --journey <your manifest.json> --from <phase-id>  — the manifest is the journey file you authored (phases: ${e.runs.map((r) => r.phaseId).join(", ")})`)}`
      );
    }
    console.log("");
  }
}

// ---------- the loop ----------

export async function runHome(): Promise<void> {
  for (;;) {
    const all = await scanRuns("runs");
    const active = all.filter((r) => !r.completedAt);
    const hidden = all.length - active.length;
    const entries = toEntries(active);

    renderHome(entries, hidden);

    const choices: { name: string; value: string; description?: string }[] = [];
    if (entries.length > 0) {
      choices.push({ name: "▸ Resume a run", value: "resume", description: "pick up where a run left off (its roles reattach to their sessions)" });
    }
    choices.push({ name: "✦ Start something new", value: "new", description: "the setup wizard: roles, goal, checkpoints" });
    if (active.length > 0) {
      choices.push({
        name: "⧉ Combine past runs into a new run",
        value: "combine",
        description: "seed a fresh run with the final state of one or more prior runs",
      });
      choices.push({
        name: "✔ Mark runs complete",
        value: "complete",
        description: "shelve finished work — hidden from these menus, untouched on disk",
      });
    }
    choices.push({ name: dim("Exit"), value: "exit" });

    const action = await select({ message: "What next?", choices });

    if (action === "exit") return;

    if (action === "new") {
      await runOrchestrator({});
      return; // (runOrchestrator does not normally return)
    }

    if (action === "resume") {
      const run = await pickRun(entries, "Resume which run?");
      if (run === BACK) continue;
      await resumeOrchestrator(run.dir);
      return;
    }

    if (action === "combine") {
      const flat = entries.flatMap((e) => e.runs);
      const picked = await checkbox<RunSummary>({
        message: "Combine which runs? (space to select, enter to confirm)",
        pageSize: 12,
        choices: flat.map((r) => ({
          name: `${r.name}  ${dim(`· ${ellipsize(r.goal, 60)}`)}`,
          value: r,
        })),
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
      const ok = await confirm({
        message: `Shelve ${runCount} run(s)? (hidden from menus; nothing deleted; restorable by hand)`,
        default: true,
      });
      if (!ok) continue;
      const stamp = new Date().toISOString();
      for (const e of picked) {
        for (const r of e.runs) {
          await updateState(r.dir, { completedAt: stamp });
        }
      }
      printCompletionNotes(picked);
      continue; // back to the (refreshed) home screen
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
