import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, ChildProcess } from "node:child_process";
import readline from "node:readline";
import { confirm, editor, number } from "@inquirer/prompts";
import { ClaudeSession } from "./claude.js";
import {
  appendTranscript,
  clearFile,
  isSafeWord,
  safeWrite,
  watchFile,
} from "./ipc.js";
import { parseMarkdown } from "./parse.js";
import { chooseSelection, renderSelection } from "./select.js";
import { Dashboard } from "./dashboard.js";
import { parseTeamBlocks, runHuddle, type TeamIO, type TeamResult, type TeamSpec } from "./team.js";
import {
  DEFAULT_TIER,
  type LaunchConfig,
  MODEL_IDS,
  type ModelTier,
  normalizeTier,
  readLedger,
  readRunCost,
  readState,
  recordUsage,
  type RoleSpec,
  type RunState,
  updateState,
  writeLedger,
} from "./persist.js";

const DEFAULT_MAX_MINUTES = 10;

/**
 * How long a checkpoint waits for your input before auto-continuing and arming
 * the next one. Keeps the checkpoint a reliable heartbeat instead of stalling
 * the whole cadence when no one is watching. Set MD_AGENT_CHECKPOINT_GRACE=0 to
 * restore the old behavior (block indefinitely until you respond).
 */
const CHECKPOINT_GRACE_MS = (() => {
  const v = process.env.MD_AGENT_CHECKPOINT_GRACE;
  if (v == null) return 120_000;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 120_000;
})();

/**
 * Default for the setup wizard's "allow sub-teams?" prompt. Sub-teams are opt-in
 * per run (chosen at setup and stored in state); MD_AGENT_TEAMS=1 just pre-sets
 * the prompt to "yes". When off, the orchestrator isn't told huddles exist.
 */
const TEAMS_DEFAULT = /^(1|true|on|yes)$/i.test(process.env.MD_AGENT_TEAMS ?? "");

/**
 * Concrete model for the orchestrator session. The orchestrator is the
 * highest-context seat in the run; MD_AGENT_ORCH_MODEL lets you pin it (a tier
 * name like "sonnet"/"haiku" or a concrete id). Unset → the claude CLI default.
 */
function resolveOrchModel(): string | undefined {
  const m = process.env.MD_AGENT_ORCH_MODEL?.trim();
  if (!m) return undefined;
  return m in MODEL_IDS ? MODEL_IDS[m as ModelTier] : m;
}

/** Build the orchestrator's system prompt from the run's goal/roles/context. */
function buildOrchSystem(state: RunState): string {
  return [
    "You are the Orchestrator. You coordinate specialized role-agents to achieve a goal.",
    `Goal: ${state.goal}`,
    "Roles:",
    ...state.roles.map(
      (r, i) =>
        `  ${i + 1}. ${r.name ? `(name: ${r.name}) ` : "(name: ?) "}${r.description}`
    ),
    state.context ? `\nShared context:\n${state.context}` : "",
    "",
    "HOW YOUR MEMORY WORKS — READ CAREFULLY:",
    "You are STATELESS between turns. You do NOT remember previous turns. Each turn you are handed:",
    "  (1) the current LEDGER — your entire externalized memory of the run, and",
    "  (2) a single NEW EVENT (a role's report, a user message, or a nudge to continue).",
    "Anything you need to remember for next turn MUST be written into the ledger you emit this turn. If it is not in the ledger, it is gone.",
    "",
    "EVERY turn (after the one-time setup JSON) you reply with TWO parts, in this order:",
    "  1. A replacement ledger, wrapped exactly like this:",
    "       <<<LEDGER",
    "       ...your full updated ledger...",
    "       LEDGER>>>",
    "  2. Zero or more TO: blocks — the messages to dispatch to roles this turn:",
    "       TO: <role-name>",
    "       <message body>",
    "     Separate multiple TO: blocks with a line containing only ---.",
    "Zero TO: blocks is valid and normal — when you've only updated your memory and are waiting on in-flight roles, emit the ledger and no TO: blocks.",
    "",
    "LEDGER DISCIPLINE (this is what keeps the run cheap and coherent):",
    "- Keep it COMPACT and rewrite it in full each turn. Target a page, not a transcript.",
    "- Hold: the current plan/phase, one status line per role (idle / working on X / blocked on Y / done), open questions, key decisions, and POINTERS (file paths, KB ids) to where detail lives.",
    "- NEVER paste raw content, full role outputs, code, or long logs into the ledger — write a one-line summary and a pointer to the file/KB entry instead. Detail is retrieved on demand, not carried.",
    "- Prune resolved items aggressively. The ledger is working memory, not a log — the transcript and shared files are the permanent record.",
    "",
    "DISPATCH DISCIPLINE:",
    "- Roles report concise STATUS, not full deliverables; their detailed work lives in shared files. Coordinate on those summaries — never ask a role to echo a large artifact back through you.",
    "- Don't paste one role's output into another's message — summarize the relevant decision and point to the file.",
    "- The literal single-word message `exit` is sent to all roles when the user terminates the run.",
    "",
    "TIME & SCOPING:",
    "- Each turn begins with a ⏱ time line (elapsed, and remaining if a budget is set). Treat it as real and scope to it.",
    "- Prefer landing small, verifiable, committable units of work over starting work you cannot finish in the time available. When you dispatch, size the ask to fit the window and tell the role the bound.",
    "- As a budget nears or is exceeded, wind down: drive in-flight work to a finished, committed state and start nothing new. Going over time is tolerated only to LAND work already underway — it is an exception, not the default.",
    "",
    "KEEP MOVING — minimize ceremony that doesn't advance the goal (don't eliminate needed coordination, but spend as little on it as you safely can):",
    "- Information already in your ledger is authoritative. Don't block work waiting for it to be re-written into a doc/spec/sign-off — proceed on what you know and let the artifact catch up.",
    "- Ground truth is the build, the tests, and the running app — not a reconstructed commit map or SHA archaeology. To learn whether something works or shipped, have a role run/check it; don't burn turns theorizing.",
    "- Process artifacts (commit maps, DAG placement, status reconciliation, audit reformatting, ID rulings) are overhead, not progress. Touch them only when they directly unblock real work or a real release — and briefly.",
    "- A dependency is real only if A literally cannot be built without B's output. A pending doc, review, or 'map' is not a real dependency — don't serialize behind it.",
    "- Don't re-open items the ledger marks closed; stop at definition-of-done (test green), not at perfect. If a role is blocked, resolve or re-scope it the same turn rather than parking it.",
    state.autoComplete
      ? [
          "",
          "FINISHING — YOU MAY END THE RUN YOURSELF:",
          "When the goal is fully achieved AND every role is idle AND all work is committed/written to its artifact, do NOT sit idle waiting for a checkpoint or the budget. End the run: emit your final updated ledger, NO TO: blocks, and — on its own line, outside the ledger — exactly:",
          "  [[PHASE-COMPLETE]] <one-line reason>",
          "End only when the work is genuinely done — never to escape a hard problem. If you are blocked, keep working or surface the blocker; do not emit the completion sentinel to bail out. Once emitted, the run tears down cleanly and (in a journey) hands off to the next phase.",
        ].join("\n")
      : "",
    state.teams
      ? [
          "",
          "SUB-TEAMS (optional — use sparingly):",
          "When two roles need to iterate tightly on a sub-problem (back-and-forth that would otherwise thrash through you one slow turn at a time), send them off as a huddle instead of a TO: block:",
          "  TEAM: <team-name> members=<roleA>,<roleB> reporter=<roleA> maxRounds=<N>",
          "  <the shared task brief for the two of them>",
          "They talk to each other directly; you do NOT see the back-and-forth. You get ONE consolidated result back ([TEAM ... DONE/BLOCKED/CAPPED]) — fold that into your ledger like any other event.",
          "Exactly TWO members. Use a huddle only when tight pairing genuinely helps; otherwise a normal TO: dispatch is cheaper. While a huddle runs, do not TO: its members — they're busy.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Orchestrator entry. Walks setup wizard, names the run, spawns role
 * processes, then enters the main event loop.
 */
export async function runOrchestrator(opts: { contextFile?: string }): Promise<void> {
  // -------- 1. Wizard --------
  const n = await number({
    message: "How many roles?",
    min: 1,
    max: 12,
    required: true,
  });

  const roles: RoleSpec[] = [];
  for (let i = 1; i <= n!; i++) {
    const desc = await editor({
      message: `Describe role ${i} (optionally start with "Name: description")`,
      waitForUserInput: false,
      validate: (v) => v.trim().length > 0 || "Required",
    });
    const m = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]+)$/.exec(desc.trim());
    if (m) {
      roles.push({ name: slug(m[1]), description: m[2].trim() });
    } else {
      roles.push({ name: "", description: desc.trim() });
    }
  }

  const goal = await editor({
    message: "What is the overall goal?",
    waitForUserInput: false,
    validate: (v) => v.trim().length > 0 || "Required",
  });

  const maxMinutes = await number({
    message: "Max minutes between synopsis checkpoints?",
    default: DEFAULT_MAX_MINUTES,
    min: 1,
    max: 24 * 60,
    required: true,
  });

  const teams = await confirm({
    message:
      "Allow the orchestrator to form sub-teams (send two roles into a 1:1 huddle)?",
    default: TEAMS_DEFAULT,
  });

  const budgetMinutes = await number({
    message: "Soft time budget in minutes (blank = none; over-runs tolerated to land in-flight work)?",
    min: 1,
    max: 24 * 60,
    required: false,
  });

  let contextContent: string | undefined;
  if (opts.contextFile) {
    const raw = await readFile(opts.contextFile, "utf8");
    const parsed = parseMarkdown(raw);
    console.log(
      `Loaded ${opts.contextFile} — ${parsed.sections.length} section(s), ${parsed.codeBlocks.length} code block(s).`
    );
    const sel = await chooseSelection(parsed);
    contextContent = renderSelection(parsed, sel);
  }

  // Hand the assembled answers to the shared launcher. The wizard supplies no
  // run name or per-role models, so launchRun runs the one-time bootstrap turn
  // to invent them (the config/journey path can pre-supply them and skip it).
  await launchRun({
    goal: goal!,
    roles,
    maxMinutes: maxMinutes ?? DEFAULT_MAX_MINUTES,
    teams,
    budgetMinutes: budgetMinutes ?? undefined,
    contextContent,
    kickoff: "Begin the run.",
  });
}

/** A fully-resolved run handed to {@link launchRun}. */
export interface RunSetup {
  goal: string;
  roles: RoleSpec[];
  maxMinutes: number;
  teams: boolean;
  budgetMinutes?: number;
  contextContent?: string;
  /** Let the orchestrator end the run itself when the goal is met (see RunState.autoComplete). */
  autoComplete?: boolean;
  /** Pre-chosen kebab run name; with full role names+models this skips bootstrap. */
  runName?: string;
  /** First event handed to the orchestrator. Defaults to "Begin the run." */
  kickoff?: string;
  /** Explicit run directory (journey phases pin this); else timestamped under runs/. */
  runDir?: string;
}

/**
 * Build the orchestrator, (only if needed) bootstrap the run name + role
 * names/models, create the run dir, spawn roles, and enter the loop. Shared by
 * the interactive wizard ({@link runOrchestrator}) and the non-interactive
 * config/journey paths ({@link runFromConfig}).
 *
 * NOTE: runLoop terminates the process on `exit` (via process.exit in stopAll),
 * so this normally does not return. The journey driver therefore runs each
 * phase as a CHILD process and observes its exit rather than awaiting a return.
 */
export async function launchRun(setup: RunSetup): Promise<void> {
  const roles = setup.roles.map((r) => ({ ...r }));
  const orchSystem = buildOrchSystem({
    goal: setup.goal,
    roles,
    context: setup.contextContent,
    teams: setup.teams,
    autoComplete: setup.autoComplete,
  });
  // The orchestrator runs STATELESS: each turn it gets the ledger + new event,
  // so resident context stays bounded and cache expiry between slow role turns
  // becomes cheap rather than catastrophic.
  const orch = new ClaudeSession({
    systemPrompt: orchSystem,
    model: resolveOrchModel(),
    stateless: true,
  });

  let runName = setup.runName ? slug(setup.runName) : "";
  const needBootstrap =
    !runName || roles.some((r) => !r.name) || roles.some((r) => !r.model);

  if (needBootstrap) {
    const unnamed = roles.map((r, i) => ({ ...r, i })).filter((r) => !r.name);
    const bootstrap = [
      "SETUP TASK — respond with a single JSON object and absolutely nothing else.",
      "No preamble, no markdown fence, no explanation.",
      "",
      "Shape:",
      `{"run_name":"kebab-case-short-name","role_names":{"<1-based-index>":"<kebab-case-name>"},"role_models":{"<1-based-index>":"opus|sonnet|haiku"}}`,
      "",
      `- run_name: a 2–4 word kebab-case descriptor of this run derived from the goal.`,
      unnamed.length > 0
        ? `- role_names: an object mapping each unnamed role index (${unnamed
            .map((u) => u.i + 1)
            .join(", ")}) to a short kebab-case name fitting that role's description.`
        : `- role_names: an empty object {}.`,
      `- role_models: map EVERY role index (1..${roles.length}) to the model tier best matched to that role's cognitive load:`,
      `    "opus"   — deepest reasoning: architecture & system design, security analysis, ambiguous judgment calls, planning, synthesizing many inputs.`,
      `    "sonnet" — strong general-purpose default: most engineering, analysis, research, and writing.`,
      `    "haiku"  — fast & cheap: simple, mechanical, narrowly-scoped, or high-volume tasks.`,
      `  Choose per role on its merits — design-heavy roles benefit from "opus"; do NOT default everything to one tier.`,
      "",
      "Output ONLY the JSON.",
    ].join("\n");

    console.log("\n[orchestrator] bootstrapping run name + role names...");
    const bootReply = await orch.send(bootstrap);
    console.log(`[orchestrator] bootstrap reply (raw):\n${bootReply}\n`);
    try {
      const parsed = JSON.parse(extractJson(bootReply));
      // Respect anything pre-supplied: only fill the gaps.
      if (!runName && typeof parsed.run_name === "string") runName = slug(parsed.run_name);
      if (parsed.role_names && typeof parsed.role_names === "object") {
        for (const [k, v] of Object.entries(parsed.role_names)) {
          const idx = Number(k) - 1;
          if (Number.isInteger(idx) && idx >= 0 && idx < roles.length && !roles[idx].name) {
            roles[idx].name = slug(String(v));
          }
        }
      }
      if (parsed.role_models && typeof parsed.role_models === "object") {
        for (const [k, v] of Object.entries(parsed.role_models)) {
          const idx = Number(k) - 1;
          if (Number.isInteger(idx) && idx >= 0 && idx < roles.length && !roles[idx].model) {
            roles[idx].model = normalizeTier(String(v));
          }
        }
      }
    } catch (e) {
      console.warn(`[orchestrator] could not parse bootstrap JSON: ${(e as Error).message}`);
      console.warn("[orchestrator] using fallback names + default model.");
    }
  } else {
    console.log("[orchestrator] launch config fully specified — skipping bootstrap turn.");
  }

  if (!runName) runName = "run";
  // Fallback names for anything still unnamed.
  roles.forEach((r, i) => {
    if (!r.name) r.name = `role-${i + 1}`;
  });
  // Default model tier for any role still unassigned.
  roles.forEach((r) => {
    if (!r.model) r.model = DEFAULT_TIER;
  });

  // -------- Create run dir --------
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  const runDir = setup.runDir
    ? path.resolve(setup.runDir)
    : path.resolve(`runs/${ts}-${runName}`);
  await mkdir(path.join(runDir, "inbox"), { recursive: true });
  await mkdir(path.join(runDir, "outbox"), { recursive: true });
  await mkdir(path.join(runDir, "sessions"), { recursive: true });
  const state: RunState = {
    goal: setup.goal,
    roles,
    context: setup.contextContent,
    maxMinutes: setup.maxMinutes,
    teams: setup.teams,
    budgetMinutes: setup.budgetMinutes,
    autoComplete: setup.autoComplete,
  };
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state, null, 2), "utf8");

  // The ledger is the orchestrator's externalized memory; it starts empty and
  // the orchestrator populates it on its first turn. It is also what makes a
  // run resumable — no session id to reattach.
  await writeFile(path.join(runDir, "ledger.md"), "", "utf8");

  // Initialize empty inbox/outbox files
  for (const r of roles) {
    await writeFile(path.join(runDir, "inbox", `${r.name}.txt`), "", "utf8");
    await writeFile(path.join(runDir, "outbox", `${r.name}.txt`), "", "utf8");
  }

  const transcript = path.join(runDir, "transcript.md");
  await writeFile(
    transcript,
    `# Run ${path.basename(runDir)}\n\nGoal: ${setup.goal}\n\nRoles:\n${roles
      .map((r) => `- **${r.name}**: ${r.description}`)
      .join("\n")}\n`,
    "utf8"
  );

  console.log(`\n[orchestrator] run dir: ${runDir}`);
  console.log(
    `[orchestrator] roles + models:\n${roles
      .map((r) => `    ${r.name} → ${r.model}`)
      .join("\n")}\n`
  );

  // -------- Spawn role processes + enter the loop --------
  const children = roles.map((r) => spawnRole(r.name, runDir, false));

  await runLoop({
    runDir,
    roles,
    transcript,
    orch,
    children,
    checkpointMinutes: state.maxMinutes!,
    kickoff: setup.kickoff ?? "Begin the run.",
    teamsEnabled: state.teams ?? false,
    budgetMinutes: state.budgetMinutes,
    autoComplete: state.autoComplete ?? false,
  });
}

/**
 * Launch a run from a JSON config file (no wizard; the console UI still runs).
 * Reachable via `--launch <file>` and used by the journey driver per phase.
 * Paths in the config (`context`, `inbox`) resolve relative to the config file.
 */
export async function runFromConfig(configPath: string): Promise<void> {
  const abs = path.resolve(configPath);
  const cfg = JSON.parse(await readFile(abs, "utf8")) as LaunchConfig;
  if (!cfg.goal || !Array.isArray(cfg.roles) || cfg.roles.length === 0) {
    throw new Error(`Launch config ${configPath} needs a "goal" and a non-empty "roles" array.`);
  }
  const baseDir = path.dirname(abs);

  let contextContent: string | undefined;
  if (cfg.context) {
    contextContent = await readFile(path.resolve(baseDir, cfg.context), "utf8");
  }
  if (cfg.inbox) {
    const inboxPath = path.resolve(baseDir, cfg.inbox);
    if (existsSync(inboxPath)) {
      const ib = (await readFile(inboxPath, "utf8")).trim();
      if (ib) {
        contextContent =
          (contextContent ? contextContent + "\n\n" : "") +
          "## Parting handshake from the prior phase (read first)\n\n" +
          ib;
      }
    }
  }

  await launchRun({
    goal: cfg.goal,
    roles: cfg.roles,
    maxMinutes: cfg.maxMinutes ?? DEFAULT_MAX_MINUTES,
    teams: cfg.teams ?? TEAMS_DEFAULT,
    budgetMinutes: cfg.budgetMinutes,
    autoComplete: cfg.autoComplete,
    contextContent,
    runName: cfg.name,
    kickoff: cfg.kickoff,
    runDir: cfg.runDir,
  });
}

/**
 * Resume an existing run. Reattaches the orchestrator (and each role) to its
 * stored claude session when available, otherwise replays transcript history.
 */
export async function resumeOrchestrator(
  runDir: string,
  opts: { minutes?: number } = {}
): Promise<void> {
  if (!existsSync(path.join(runDir, "state.json"))) {
    console.error(`No resumable run at ${runDir} (missing state.json).`);
    process.exit(1);
  }
  const state = await readState(runDir);
  const roles = state.roles;
  const transcript = path.join(runDir, "transcript.md");
  const storedMinutes = state.maxMinutes ?? DEFAULT_MAX_MINUTES;
  let checkpointMinutes = storedMinutes;
  if (opts.minutes != null) {
    // Explicit --minutes flag wins; skip the prompt.
    checkpointMinutes = Math.max(1, Math.min(24 * 60, Math.floor(opts.minutes)));
  } else {
    // No flag — ask, defaulting to the run's stored interval.
    const answer = await number({
      message: "Minutes between checkpoints for this resumed run?",
      default: storedMinutes,
      min: 1,
      max: 24 * 60,
      required: true,
    });
    checkpointMinutes = answer ?? storedMinutes;
  }
  if (checkpointMinutes !== storedMinutes || opts.minutes != null) {
    await updateState(runDir, { maxMinutes: checkpointMinutes });
  }
  console.log(`[orchestrator] checkpoint interval: ${checkpointMinutes} min (persisted)`);

  // Soft time budget for THIS session (resets per resume — "give it a 15-min run").
  const resumeBudgetMinutes = await number({
    message: "Soft time budget for this session in minutes (blank = none; over-runs tolerated to land in-flight work)?",
    default: state.budgetMinutes,
    min: 1,
    max: 24 * 60,
    required: false,
  });
  await updateState(runDir, { budgetMinutes: resumeBudgetMinutes ?? undefined });
  console.log(
    `[orchestrator] time budget: ${resumeBudgetMinutes != null ? resumeBudgetMinutes + " min" : "none"}`
  );

  console.log(`\n[orchestrator] resuming run: ${runDir}`);
  console.log(`[orchestrator] roles: ${roles.map((r) => r.name).join(", ")}`);

  // The orchestrator is stateless — its memory is the ledger on disk, so resume
  // needs no session reattachment or transcript replay. It will read the
  // existing ledger on its first turn and continue.
  if (existsSync(path.join(runDir, "ledger.md"))) {
    console.log("[orchestrator] ledger found — resuming from it");
  } else {
    console.log("[orchestrator] no ledger (pre-ledger run) — starting memory fresh");
  }
  const orch = new ClaudeSession({
    systemPrompt: buildOrchSystem(state),
    model: resolveOrchModel(),
    stateless: true,
  });

  // Clear stale inbox/outbox so freshly spawned roles don't reprocess leftover
  // content (notably the `exit` sentinel written on a prior clean shutdown).
  await mkdir(path.join(runDir, "sessions"), { recursive: true });
  for (const r of roles) {
    await clearFile(path.join(runDir, "inbox", `${r.name}.txt`));
    await clearFile(path.join(runDir, "outbox", `${r.name}.txt`));
  }

  await appendTranscript(transcript, "RUN RESUMED", `Resumed from ${runDir}`);

  const children = roles.map((r) => spawnRole(r.name, runDir, true));

  await runLoop({
    runDir,
    roles,
    transcript,
    orch,
    children,
    checkpointMinutes,
    kickoff:
      "The run is resuming after a pause. Re-orient using your memory of the run so far, " +
      "then continue coordinating toward the goal. If you were waiting on a role, re-issue the request.",
    teamsEnabled: state.teams ?? false,
    budgetMinutes: resumeBudgetMinutes,
    autoComplete: state.autoComplete ?? false,
  });
}

function spawnRole(name: string, runDir: string, resume: boolean): ChildProcess {
  const isTs = process.argv[1].endsWith(".ts");
  const args = [
    ...(isTs ? ["--import", "tsx", process.argv[1]] : [process.argv[1]]),
    "--role",
    name,
    "--run",
    runDir,
    ...(resume ? ["--resumed"] : []),
  ];
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  console.log(`[orchestrator] spawned role ${name} (pid ${child.pid})`);
  return child;
}

interface LoopCtx {
  runDir: string;
  roles: RoleSpec[];
  transcript: string;
  orch: ClaudeSession;
  children: ChildProcess[];
  checkpointMinutes: number;
  kickoff: string;
  /** Whether the orchestrator may form sub-teams (per-run setup choice). */
  teamsEnabled: boolean;
  /** Soft time budget in minutes for this session; undefined = elapsed-only. */
  budgetMinutes?: number;
  /** Allow the orchestrator to self-terminate via [[PHASE-COMPLETE]] when the goal is met. */
  autoComplete: boolean;
}

/** Shared event loop used by both fresh runs and resumes. */
async function runLoop(ctx: LoopCtx): Promise<void> {
  const { runDir, roles, transcript, orch, children, kickoff, teamsEnabled, budgetMinutes, autoComplete } = ctx;

  // Give the orchestrator's own claude session a heartbeat file so the watchdog
  // can tell a working turn (recent stream output) from one hung mid-turn. Roles
  // get theirs at spawn; the orchestrator's run dir only exists by now, so set it
  // here rather than at construction (the bootstrap turn ran before the run dir).
  const orchHeartbeatFile = path.join(runDir, "sessions", "orchestrator.heartbeat");
  orch.setHeartbeatPath(orchHeartbeatFile);

  // Session clock — drives the ⏱ time signal injected into every orchestrator
  // turn so the (stateless) orchestrator can scope work to the time available.
  const sessionStart = Date.now();
  function timeStatus(): string {
    const elapsed = Math.round((Date.now() - sessionStart) / 60000);
    if (budgetMinutes == null) {
      return `⏱ ~${elapsed} min into this session.`;
    }
    const remaining = budgetMinutes - elapsed;
    if (remaining >= 0) {
      return `⏱ ~${elapsed} min in, ~${remaining} min left of a ~${budgetMinutes} min budget — scope work to finish and commit within it.`;
    }
    return `⏱ ~${elapsed} min in, OVER the ~${budgetMinutes} min budget by ~${-remaining} min — WIND DOWN: drive in-flight work to a committed state and start nothing new (over-runs are tolerated only to land work already underway).`;
  }

  // Serialize every orchestrator turn. Outbox watchers fire independently, and
  // each turn does a read-modify-write of the shared ledger — without this,
  // two role replies could interleave and clobber each other's ledger update.
  // The whole critical section (read ledger → send → record cost → write
  // ledger) runs inside the lock. Also tracks whether the last reply carried a
  // ledger, so dispatch knows a no-TO-block turn is legitimate vs. malformed.
  let orchLock: Promise<unknown> = Promise.resolve();
  let lastHadLedger = false;
  // Orchestrator-progress watchdog state (logic armed with the role watchdog below).
  // The orchestrator only advances when something calls askOrch (a role reply, user
  // input, a team result, a checkpoint WITH input, or a watchdog nudge) — the
  // checkpoint auto-continue deliberately does not. So a turn that ends with no
  // dispatch and no role pending leaves nothing to re-invoke it: a silent deadlock.
  // These track the orchestrator's own liveness so the watchdog can break it.
  let orchBusy = false; // an askOrch turn is currently in flight
  let lastOrchTurnAt = Date.now(); // ms of the last completed orchestrator turn
  let orchStallNudges = 0; // consecutive progress nudges that produced no real progress

  // ---------- role-liveness watchdog (state; logic armed lower down) ----------
  // A role child that crashes or hangs without writing its outbox would strand
  // the orchestrator forever — it only acts on outbox writes / user input, and
  // checkpoints auto-continue without re-poking. Track each outstanding
  // dispatch; a dead (or long-silent) role gets re-spawned (resuming its
  // session) and surfaced to the orchestrator so it re-issues the work.
  const childByRole = new Map<string, ChildProcess>();
  const aliveByRole = new Map<string, boolean>();
  const pendingSince = new Map<string, number>(); // role -> ms of its outstanding dispatch
  const recovering = new Set<string>();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  roles.forEach((r, i) => {
    childByRole.set(r.name, children[i]);
    aliveByRole.set(r.name, true);
  });

  /**
   * Run one orchestrator turn. `eventText` is just the new event (a role
   * report, user input, or a nudge); askOrch wraps it with the current ledger.
   * The orchestrator replies with a replacement ledger + TO: blocks; we persist
   * the ledger and return only the TO-block text for dispatch.
   */
  async function askOrch(eventText: string): Promise<string> {
    const task = orchLock.then(async () => {
      orchBusy = true;
      const endTurn = () => {
        orchBusy = false;
        lastOrchTurnAt = Date.now(); // a completed turn resets the idle clock
      };
      try {
        const ledger = await readLedger(runDir);
        const reply = await orch.send(composeOrchPrompt(ledger, eventText));
        const u = orch.lastUsage;
        if (u) {
          await recordUsage(runDir, "orchestrator", u);
          try {
            dash.setCost((await readRunCost(runDir)).costUsd);
          } catch {
            // Cost display is best-effort; never let it break the run.
          }
        }
        const extracted = extractLedger(reply);
        lastHadLedger = extracted.ledger !== null;
        if (extracted.ledger !== null) await writeLedger(runDir, extracted.ledger);
        // Self-termination: when allowed, an orchestrator that declares the goal
        // done ends the run cleanly (same teardown as `exit`) instead of idling —
        // in a journey this triggers the handshake and advances to the next phase.
        if (autoComplete) {
          // Only a DELIBERATE completion signal counts: the sentinel must START a
          // line in the dispatch area AND the turn must carry no TO: blocks (a real
          // completion dispatches nothing). This rejects false-positives where the
          // orchestrator merely quotes or negates the sentinel while reasoning
          // (e.g. "I will NOT emit [[PHASE-COMPLETE]] yet").
          const done = /^[ \t]*\[\[PHASE-COMPLETE\]\][ \t]*(.*)$/im.exec(extracted.rest);
          if (done && parseDispatch(extracted.rest).length === 0) {
            const reason = done[1].trim() || "goal achieved";
            console.log(`[orchestrator] phase complete — ${reason}`);
            await appendTranscript(transcript, "PHASE COMPLETE", reason);
            void stopAll(`phase complete: ${reason}`);
            return ""; // winding down — nothing to dispatch this turn
          }
        }
        return extracted.rest;
      } finally {
        endTurn();
      }
    });
    orchLock = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  function composeOrchPrompt(ledger: string, eventText: string): string {
    return [
      timeStatus(),
      "",
      "===== CURRENT LEDGER (your memory — all you know about this run) =====",
      ledger.trim() || "(empty — this is the start of the run)",
      "===== END LEDGER =====",
      "",
      "===== NEW EVENT =====",
      eventText,
      "===== END EVENT =====",
      "",
      `Roles you may dispatch to: ${roles.map((r) => r.name).join(", ")}.`,
      "Reply with a full replacement ledger inside <<<LEDGER ... LEDGER>>>, then zero or more TO: blocks (separate multiple with a line containing only ---). Keep the ledger compact: status + pointers, never raw content.",
    ].join("\n");
  }

  // ---------- sub-teams (1:1 huddles) ----------
  // A role "owned" by a team has its outbox routed to the huddle, not the
  // orchestrator. pendingTeamReply holds the one-shot resolver the watcher fires
  // when a member's reply arrives.
  const teamOwner = new Map<string, string>();
  const pendingTeamReply = new Map<string, (reply: string) => void>();

  async function askMember(role: string, message: string): Promise<string> {
    // Register the resolver BEFORE writing the inbox so a fast reply can't race
    // ahead of it.
    const reply = new Promise<string>((res) => pendingTeamReply.set(role, res));
    dash.flow("orch", role);
    await appendTranscript(transcript, `→ ${role} (team)`, message);
    await safeWrite(path.join(runDir, "inbox", `${role}.txt`), message);
    return reply;
  }

  async function appendChannel(team: string, who: string, msg: string): Promise<void> {
    const dir = path.join(runDir, "teams", team);
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "channel.md"), `\n## ${who}\n\n${msg.trim()}\n`, "utf8");
  }

  const teamIO: TeamIO = {
    ask: askMember,
    appendChannel,
    isStopping: () => stopping,
  };

  async function startTeam(spec: TeamSpec): Promise<void> {
    for (const m of spec.members) {
      if (!roles.find((r) => r.name === m)) {
        console.warn(`[orchestrator] team "${spec.name}": unknown member "${m}", skipping team`);
        return;
      }
      if (teamOwner.has(m)) {
        console.warn(`[orchestrator] team "${spec.name}": "${m}" is busy in team "${teamOwner.get(m)}", skipping`);
        return;
      }
    }
    for (const m of spec.members) teamOwner.set(m, spec.name);
    dash.setStatus(`huddle ${spec.name}: ${spec.members.join(" ↔ ")}`);
    console.log(`[orchestrator] huddle "${spec.name}" started: ${spec.members.join(" ↔ ")}`);
    await appendTranscript(transcript, `TEAM START ${spec.name}`, `${spec.members.join(", ")} — ${spec.brief}`);

    let result: TeamResult;
    try {
      result = await runHuddle(spec, teamIO);
    } catch (e) {
      result = { status: "aborted", report: `(error: ${(e as Error).message})` };
    } finally {
      for (const m of spec.members) teamOwner.delete(m);
    }

    await appendTranscript(transcript, `TEAM ${result.status.toUpperCase()} ${spec.name}`, result.report);
    if (stopping) return;
    // Fold the single consolidated result back into the orchestrator's ledger.
    const event = `[TEAM ${spec.name} ${result.status.toUpperCase()}] (members: ${spec.members.join(", ")})\n${result.report}`;
    const reply = await askOrch(event);
    printOrchReply(reply);
    await dispatch(reply);
  }

  const dash = new Dashboard({
    runName: path.basename(runDir),
    roles: roles.map((r) => ({ name: r.name, model: r.model ?? "sonnet" })),
    intervalMin: ctx.checkpointMinutes,
  });
  dash.start();

  let stopping = false;
  const stopAll = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    if (watchdog) clearInterval(watchdog);
    dash.setStatus(`stopping — ${reason}`);
    dash.stop();
    console.log(`\n[orchestrator] stopping (${reason})`);
    await appendTranscript(transcript, "RUN END", reason);
    for (const r of roles) {
      await safeWrite(path.join(runDir, "inbox", `${r.name}.txt`), "exit");
    }
    // Give children a moment to exit cleanly
    setTimeout(() => {
      for (const c of childByRole.values()) {
        if (!c.killed) c.kill();
      }
      process.exit(0);
    }, 2000);
  };

  // Kick off: ask the orchestrator for the first (or resumed) dispatch.
  console.log("[orchestrator] requesting initial dispatch...");
  const firstDispatch = await askOrch(kickoff);
  printOrchReply(firstDispatch);
  await dispatch(firstDispatch);

  // Watch each outbox
  for (const r of roles) {
    const outbox = path.join(runDir, "outbox", `${r.name}.txt`);
    watchFile(outbox, async (content) => {
      if (stopping) return;
      if (isSafeWord(content)) return; // role echoed safe word; nothing to do

      // If this role is huddling, its reply belongs to the team runner, not the
      // orchestrator — hand it to the waiting resolver and stop here.
      const pending = pendingTeamReply.get(r.name);
      if (pending) {
        pendingTeamReply.delete(r.name);
        await clearFile(outbox);
        dash.flow(r.name, "orch");
        await appendTranscript(transcript, `← ${r.name} (team)`, content);
        printRoleReply(r.name, content);
        pending(content);
        return;
      }
      if (teamOwner.has(r.name)) {
        // Owned by a team but no turn pending — unsolicited; drop so it never
        // leaks into the orchestrator's context.
        await clearFile(outbox);
        return;
      }

      dash.flow(r.name, "orch");
      pendingSince.delete(r.name); // role replied — clear its outstanding dispatch
      orchStallNudges = 0; // a role reply is progress — reset the stall escalation
      await appendTranscript(transcript, `← ${r.name}`, content);
      await clearFile(outbox);
      printRoleReply(r.name, content);
      const reply = await askOrch(`[from ${r.name}]\n${content}`);
      printOrchReply(reply);
      await dispatch(reply);
    });
  }

  // User interjection via stdin — feed to orchestrator only; it decides
  // whether/how to propagate to roles.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let interjectionsPaused = false;
  const onInterjection = async (line: string) => {
    if (interjectionsPaused) return;
    const text = line.trim();
    if (!text) return;
    if (isSafeWord(text)) {
      await stopAll("user typed exit");
      return;
    }
    console.log(`[orchestrator] forwarding user interjection to orchestrator claude`);
    await appendTranscript(transcript, "USER", text);
    const reply = await askOrch(`[USER INTERJECTION] ${text}`);
    printOrchReply(reply);
    await dispatch(reply);
  };
  rl.on("line", onInterjection);

  // Wait for one line from the user (interjections paused). Resolves to the line,
  // or null if `timeoutMs` elapses first. timeoutMs <= 0 means wait indefinitely.
  const waitForInput = (timeoutMs: number): Promise<string | null> => {
    interjectionsPaused = true;
    return new Promise<string | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (val: string | null) => {
        if (settled) return;
        settled = true;
        rl.off("line", onLine);
        if (timer) clearTimeout(timer);
        resolve(val);
      };
      const onLine = (l: string) => settle(l);
      rl.on("line", onLine);
      if (timeoutMs > 0) timer = setTimeout(() => settle(null), timeoutMs);
    }).finally(() => {
      interjectionsPaused = false;
    });
  };

  // Max-time checkpoint. checkpointMs is mutable so `interval N` can change the
  // recurring cadence; an `extend N` only overrides the very next leg.
  let checkpointMs = ctx.checkpointMinutes * 60 * 1000;
  const scheduleCheckpoint = (overrideMs?: number) => {
    setTimeout(async () => {
      if (stopping) return;
      // The ledger IS the synopsis — show it directly instead of spending a
      // model turn to regenerate one. Also write it to the transcript so every
      // checkpoint leaves a durable, timestamped footprint (point-in-time state)
      // even when you don't respond — otherwise checkpoints are invisible.
      const ledger = (await readLedger(runDir)).trim() || "(ledger empty)";
      await appendTranscript(transcript, "CHECKPOINT", ledger);

      const graceSec = Math.round(CHECKPOINT_GRACE_MS / 1000);
      const graceNote = CHECKPOINT_GRACE_MS > 0 ? ` (auto-continues in ${graceSec}s)` : "";
      dash.setStatus(`CHECKPOINT — feedback now${graceNote}`);
      console.log(`\n----- LEDGER (orchestrator memory) -----\n${ledger}\n----------------------------------------`);
      console.log(`At this checkpoint you can${graceNote ? " (or just wait)" : ""}:`);
      console.log("  <feedback>     type feedback then Enter to continue");
      console.log("  (empty)        Enter alone to continue with no feedback");
      console.log(`  extend N       run N more minutes before the NEXT checkpoint only`);
      console.log(`  interval N     change the recurring checkpoint interval to N minutes`);
      console.log("  exit           stop the run");

      const userLine = await waitForInput(CHECKPOINT_GRACE_MS);
      if (userLine === null) {
        // No one's watching — keep the heartbeat alive and re-arm, but don't
        // inject a "Continue" nudge (the orchestrator is already driven by role
        // replies; an unprompted poke would just burn a turn / invent work).
        dash.setStatus("running");
        console.log(`[orchestrator] checkpoint auto-continued (no input within ${graceSec}s)`);
        await appendTranscript(transcript, "CHECKPOINT AUTO-CONTINUED", `No input within ${graceSec}s.`);
        scheduleCheckpoint();
        return;
      }
      const fb = userLine.trim();

      if (isSafeWord(fb)) {
        await stopAll("user typed exit at checkpoint");
        return;
      }
      dash.setStatus("running");

      let nextOverrideMs: number | undefined;
      const cmd = parseCheckpointCommand(fb);
      if (cmd.kind === "extend") {
        nextOverrideMs = checkpointMs + cmd.minutes * 60 * 1000;
        console.log(
          `[orchestrator] next checkpoint in ${nextOverrideMs / 60000} min (one-time +${cmd.minutes}); recurring interval stays ${checkpointMs / 60000} min`
        );
        await appendTranscript(transcript, "CHECKPOINT EXTEND", `+${cmd.minutes} min (one-time)`);
        await continueOrch();
      } else if (cmd.kind === "interval") {
        checkpointMs = cmd.minutes * 60 * 1000;
        dash.setIntervalMinutes(cmd.minutes);
        await updateState(runDir, { maxMinutes: cmd.minutes });
        console.log(
          `[orchestrator] recurring checkpoint interval set to ${cmd.minutes} min (persisted)`
        );
        await appendTranscript(transcript, "CHECKPOINT INTERVAL", `${cmd.minutes} min`);
        await continueOrch();
      } else if (fb.length > 0) {
        await appendTranscript(transcript, "USER FEEDBACK", fb);
        const reply = await askOrch(`[USER FEEDBACK] ${fb}`);
        printOrchReply(reply);
        await dispatch(reply);
      } else {
        await continueOrch();
      }

      scheduleCheckpoint(nextOverrideMs);
    }, overrideMs ?? checkpointMs);
  };
  scheduleCheckpoint();

  // Cleanup on SIGINT
  process.on("SIGINT", () => {
    void stopAll("SIGINT");
  });

  // ---------- role-liveness watchdog (armed once all helpers exist) ----------
  // Recovers a role that is dead OR hung, without false-killing a busy one:
  //  - DEAD: the child process exited (crash) → re-spawn + re-issue.
  //  - HUNG: alive but its claude turn produced NO stream output for
  //    HEARTBEAT_STALL. The session beats a heartbeat file on every output chunk,
  //    so a working turn beats every few seconds while a stuck one (e.g. a
  //    Playwright call that never returns) goes silent. Outbox-silence is NOT the
  //    signal — a long, productive turn is outbox-silent yet still beating, and
  //    killing it on that basis derailed an earlier run.
  const WATCHDOG_INTERVAL_MS = 60_000;
  const HEARTBEAT_STALL_MS = (() => {
    const v = process.env.MD_AGENT_HEARTBEAT_STALL;
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n * 1000 : 6 * 60_000; // default 6 min
  })();
  // ---- orchestrator-progress watchdog knobs (used by the orchestrator branch) ----
  // Idle deadlock: no orchestrator turn for this long while no role work is pending.
  const ORCH_STALL_MS = (() => {
    const n = Number(process.env.MD_AGENT_ORCH_STALL);
    return Number.isFinite(n) && n > 0 ? n * 1000 : 10 * 60_000; // default 10 min
  })();
  // Mid-turn hang: the orchestrator's own claude turn emits no output for this long.
  const ORCH_HANG_MS = (() => {
    const n = Number(process.env.MD_AGENT_ORCH_HANG);
    return Number.isFinite(n) && n > 0 ? n * 1000 : 6 * 60_000; // default 6 min
  })();
  // Consecutive idle-deadlock nudges that fail to advance before the run HALTs.
  const ORCH_MAX_NUDGES = (() => {
    const n = Number(process.env.MD_AGENT_ORCH_MAX_NUDGES);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
  })();
  const heartbeatMtime = (name: string): number => {
    try {
      return statSync(path.join(runDir, "sessions", `${name}.heartbeat`)).mtimeMs;
    } catch {
      return 0;
    }
  };

  function armChildExit(name: string, child: ChildProcess): void {
    child.on("exit", () => {
      aliveByRole.set(name, false);
      if (stopping) return;
      // Exiting outside shutdown is a crash — recover (re-spawn; re-issue if it had work).
      void recoverRole(name, "its process exited");
    });
  }

  async function respawnRole(name: string): Promise<void> {
    const old = childByRole.get(name);
    if (old && old.exitCode === null && !old.killed) {
      try {
        old.kill();
      } catch {
        // best-effort; it may already be gone
      }
    }
    // Drop any stale dispatch/reply so the fresh session doesn't reprocess it.
    await clearFile(path.join(runDir, "inbox", `${name}.txt`));
    await clearFile(path.join(runDir, "outbox", `${name}.txt`));
    const child = spawnRole(name, runDir, true); // resume = keep the role's session/context
    childByRole.set(name, child);
    aliveByRole.set(name, true);
    armChildExit(name, child);
  }

  async function recoverRole(name: string, cause: string): Promise<void> {
    if (stopping || recovering.has(name) || teamOwner.has(name)) return;
    recovering.add(name);
    try {
      const since = pendingSince.get(name);
      const hadWork = since !== undefined;
      const mins = hadWork ? Math.round((Date.now() - since!) / 60000) : 0;
      const note = hadWork
        ? `${cause} after ~${mins} min with an outstanding task`
        : `${cause} while idle`;
      console.warn(`[watchdog] role "${name}" ${note} — re-spawning a fresh session`);
      dash.setStatus(`watchdog: re-spawned ${name}`);
      await appendTranscript(transcript, `WATCHDOG ${name}`, note);
      pendingSince.delete(name); // a re-dispatch will re-arm it
      await respawnRole(name);
      if (hadWork && !stopping) {
        const reply = await askOrch(
          `[SYSTEM/watchdog] Role "${name}" ${note} and produced no reply. ` +
            `A FRESH "${name}" session has been re-spawned (it resumes its prior context). ` +
            `Re-issue its outstanding task now, or re-scope it — send a TO: ${name} block.`
        );
        printOrchReply(reply);
        await dispatch(reply);
      }
    } finally {
      recovering.delete(name);
    }
  }

  // Force a stalled-but-idle orchestrator to take a turn: finalize if the goal is
  // met, else dispatch the next step. A turn that dispatches or completes resets
  // the nudge counter (see sendToRole / the outbox watcher); repeated no-progress
  // nudges escalate to haltRun.
  async function nudgeOrch(idleMs: number): Promise<void> {
    if (stopping) return;
    const mins = Math.round(idleMs / 60000);
    console.warn(
      `[watchdog] orchestrator idle ~${mins} min with no role work — nudging (#${orchStallNudges})`
    );
    dash.setStatus("watchdog: nudging orchestrator");
    await appendTranscript(
      transcript,
      "WATCHDOG orchestrator",
      `idle ~${mins} min, no outstanding role work — nudge #${orchStallNudges}`
    );
    const reply = await askOrch(
      `[SYSTEM/progress-watchdog] No role work is outstanding and you have not taken a turn for ~${mins} min. ` +
        `If the goal is met and all work is committed/written, FINALIZE now: emit your final ledger and, on its own line, [[PHASE-COMPLETE]] — with no TO: blocks. ` +
        `Otherwise dispatch the next concrete step as a TO: block this turn.`
    );
    printOrchReply(reply);
    await dispatch(reply);
  }

  // Deterministic circuit breaker: stop the run and leave a HALT marker the journey
  // driver checks (so it stops instead of advancing). Recovery via another
  // orchestrator turn is deliberately NOT attempted — if the orchestrator is the
  // thing that's stuck, re-entering it would stall the same way.
  async function haltRun(reason: string): Promise<void> {
    if (stopping) return;
    console.error(`\n[watchdog] HALT — ${reason}\n`);
    await appendTranscript(transcript, "WATCHDOG HALT", reason);
    try {
      await writeFile(path.join(runDir, "HALT.txt"), reason + "\n", "utf8");
    } catch {
      // best-effort marker; stopAll still tears the run down
    }
    await stopAll(`halt: ${reason}`);
  }

  for (const r of roles) armChildExit(r.name, childByRole.get(r.name)!);

  watchdog = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    for (const [name, since] of pendingSince) {
      if (recovering.has(name) || teamOwner.has(name)) continue;
      if (!(aliveByRole.get(name) ?? true)) {
        void recoverRole(name, "its process is gone");
        continue;
      }
      // Alive: hung iff no stream output for HEARTBEAT_STALL. Floor the activity
      // clock at the dispatch time so a just-dispatched role gets startup grace.
      const lastActivity = Math.max(since, heartbeatMtime(name));
      if (now - lastActivity > HEARTBEAT_STALL_MS) {
        const mins = Math.round((now - lastActivity) / 60000);
        void recoverRole(name, `produced no output for ~${mins} min (hung)`);
      }
    }

    // ---- orchestrator / phase-progress watchdog ----
    // The loop above only covers roles with outstanding work; nothing else watches
    // the ORCHESTRATOR itself. Two failure modes to catch (the role watchdog and a
    // checkpoint can't):
    // Only for self-completing runs (journey phases). A non-autoComplete interactive
    // run is *meant* to idle waiting for the user — nudging/halting that is wrong.
    if (!autoComplete) return;
    if (recovering.size > 0) return; // a role recovery is already driving askOrch
    if (orchBusy) {
      // A turn is in flight; only a genuine mid-turn hang is actionable. The session
      // beats orchestrator.heartbeat on every chunk, so prolonged silence = stuck.
      // Don't self-recover (that re-enters the stuck path) — HALT and surface it.
      const beat = heartbeatMtime("orchestrator");
      if (beat > 0 && now - beat > ORCH_HANG_MS) {
        const mins = Math.round((now - beat) / 60000);
        void haltRun(`orchestrator turn produced no output for ~${mins} min (hung mid-turn)`);
      }
      return;
    }
    // Idle: no turn in flight. If there's also no outstanding role work and no active
    // huddle, nothing will re-invoke the orchestrator (the checkpoint auto-continue
    // deliberately doesn't) — a silent deadlock. Force it forward, then escalate.
    if (pendingSince.size === 0 && teamOwner.size === 0) {
      const idle = now - lastOrchTurnAt;
      if (idle > ORCH_STALL_MS) {
        if (orchStallNudges < ORCH_MAX_NUDGES) {
          orchStallNudges++;
          void nudgeOrch(idle);
        } else {
          const mins = Math.round(idle / 60000);
          void haltRun(
            `no progress after ${ORCH_MAX_NUDGES} nudge(s) (~${mins} min idle, no role work, no completion)`
          );
        }
      }
    }
  }, WATCHDOG_INTERVAL_MS);

  // ---------- helpers ----------
  async function continueOrch(): Promise<void> {
    const reply = await askOrch("Continue — review the ledger and proceed toward the goal.");
    printOrchReply(reply);
    await dispatch(reply);
  }

  function printOrchReply(text: string): void {
    const blocks = parseDispatch(text);
    if (blocks.length > 0) {
      console.log(`\n[orchestrator → dispatch]`);
      for (const b of blocks) {
        const preview = b.body.length > 200 ? b.body.slice(0, 200) + "…" : b.body;
        console.log(`  → ${b.role}: ${preview.replace(/\n/g, "\n              ")}`);
      }
      console.log("");
    } else {
      console.log(`\n[orchestrator → no TO: blocks, raw reply]\n${text}\n`);
    }
  }

  function printRoleReply(roleName: string, content: string): void {
    console.log(`\n[← ${roleName}]\n${content}\n`);
  }

  async function dispatch(orchOutput: string): Promise<void> {
    // The run is winding down (e.g. after [[PHASE-COMPLETE]] triggered stopAll):
    // don't dispatch — and never hit the malformed-retry path, which would race
    // the in-flight process.exit and could crash teardown.
    if (stopping) return;
    // Sub-team dispatches run alongside (and instead of) TO: blocks.
    let startedTeam = false;
    if (teamsEnabled) {
      const { specs, errors } = parseTeamBlocks(orchOutput);
      for (const e of errors) console.warn(`[orchestrator] ${e}`);
      for (const spec of specs) {
        startedTeam = true;
        void startTeam(spec); // runs async; result folds back in when done
      }
    }

    const blocks = parseDispatch(orchOutput);
    if (blocks.length === 0) {
      if (lastHadLedger || startedTeam) {
        // Legitimate: the orchestrator updated its memory and/or launched a
        // huddle, and has nothing to dispatch directly this turn. Not an error.
        console.log("[orchestrator] no direct dispatch this turn");
        return;
      }
      // Neither a ledger nor TO: blocks — the reply was malformed. Nudge once.
      await appendTranscript(transcript, "ORCH malformed (no ledger, no TO: blocks)", orchOutput);
      console.log("[orchestrator] re-prompting for protocol-shaped reply...");
      const retry = await askOrch(
        "Your previous reply had neither a <<<LEDGER ... LEDGER>>> block nor any TO: blocks. " +
          "Re-emit your intended action: a replacement ledger followed by any TO: blocks."
      );
      const retryBlocks = parseDispatch(retry);
      if (retryBlocks.length === 0) {
        if (lastHadLedger) {
          console.log("[orchestrator] ledger updated on retry; no dispatch this turn");
        } else {
          console.warn("[orchestrator] retry still malformed; pausing until next event.");
          await appendTranscript(transcript, "ORCH retry failed", retry);
        }
        return;
      }
      console.log(`[orchestrator] retry produced ${retryBlocks.length} block(s)`);
      for (const b of retryBlocks) await sendToRole(b);
      return;
    }
    for (const b of blocks) await sendToRole(b);
  }

  /**
   * Pull the orchestrator's replacement ledger out of a reply. Returns the
   * ledger body (or null if absent) and the remaining text (the TO: blocks).
   */
  function extractLedger(reply: string): { ledger: string | null; rest: string } {
    const m = /<<<LEDGER\r?\n([\s\S]*?)\r?\nLEDGER>>>/.exec(reply);
    if (!m) return { ledger: null, rest: reply };
    const rest = (reply.slice(0, m.index) + reply.slice(m.index + m[0].length)).trim();
    return { ledger: m[1], rest };
  }

  async function sendToRole(b: { role: string; body: string }): Promise<void> {
    const known = roles.find((r) => r.name === b.role);
    if (!known) {
      console.warn(`[orchestrator] unknown role "${b.role}", skipping`);
      return;
    }
    if (teamOwner.has(b.role)) {
      console.warn(
        `[orchestrator] "${b.role}" is busy in huddle "${teamOwner.get(b.role)}"; skipping direct dispatch`
      );
      return;
    }
    dash.flow("orch", b.role);
    await appendTranscript(transcript, `→ ${b.role}`, b.body);
    await safeWrite(path.join(runDir, "inbox", `${b.role}.txt`), b.body);
    pendingSince.set(b.role, Date.now()); // mark outstanding for the liveness watchdog
    orchStallNudges = 0; // a real dispatch is progress — reset the stall escalation
  }
}

type CheckpointCommand =
  | { kind: "extend"; minutes: number }
  | { kind: "interval"; minutes: number }
  | { kind: "none" };

/** Parse a checkpoint control line. Accepts an optional leading `/`. */
function parseCheckpointCommand(line: string): CheckpointCommand {
  const s = line.trim().replace(/^\//, "");
  const clamp = (m: number) => Math.max(1, Math.min(24 * 60, Math.floor(m)));
  let m = /^(?:extend\s+|\+\s*)(\d+)$/i.exec(s);
  if (m) return { kind: "extend", minutes: clamp(Number(m[1])) };
  m = /^interval\s+(\d+)$/i.exec(s);
  if (m) return { kind: "interval", minutes: clamp(Number(m[1])) };
  return { kind: "none" };
}

function parseDispatch(text: string): { role: string; body: string }[] {
  const out: { role: string; body: string }[] = [];
  // Split on lines containing only `---`
  const chunks = text.split(/\r?\n---\r?\n/);
  for (const chunk of chunks) {
    const m = /^[ \t]*TO:[ \t]*([A-Za-z][\w-]*)[ \t]*\r?\n([\s\S]*)$/m.exec(chunk);
    if (m) {
      out.push({ role: m[1].trim(), body: m[2].trim() });
    }
  }
  return out;
}

function extractJson(text: string): string {
  // Try fenced ```json blocks first
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  // Else first {...} block
  const brace = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (brace >= 0 && close > brace) return text.slice(brace, close + 1);
  return text;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
}
