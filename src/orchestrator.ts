import path from "node:path";
import { existsSync } from "node:fs";
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

  // -------- 2. Bootstrap orchestrator claude: name run + roles --------
  // The orchestrator runs STATELESS: each turn it gets the ledger + new event,
  // so resident context stays bounded and cache expiry between slow role turns
  // becomes cheap rather than catastrophic.
  const orchSystem = buildOrchSystem({ goal: goal!, roles, context: contextContent, teams });
  const orch = new ClaudeSession({
    systemPrompt: orchSystem,
    model: resolveOrchModel(),
    stateless: true,
  });

  const unnamed = roles
    .map((r, i) => ({ ...r, i }))
    .filter((r) => !r.name);
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
  let runName = "run";
  try {
    const parsed = JSON.parse(extractJson(bootReply));
    if (typeof parsed.run_name === "string") runName = slug(parsed.run_name);
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
        if (Number.isInteger(idx) && idx >= 0 && idx < roles.length) {
          roles[idx].model = normalizeTier(String(v));
        }
      }
    }
  } catch (e) {
    console.warn(`[orchestrator] could not parse bootstrap JSON: ${(e as Error).message}`);
    console.warn("[orchestrator] using fallback names + default model.");
  }

  // Fallback names for anything still unnamed.
  roles.forEach((r, i) => {
    if (!r.name) r.name = `role-${i + 1}`;
  });

  // Default model tier for any role the orchestrator didn't assign.
  roles.forEach((r) => {
    if (!r.model) r.model = DEFAULT_TIER;
  });

  // -------- 3. Create run dir --------
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  const runDir = path.resolve(`runs/${ts}-${runName}`);
  await mkdir(path.join(runDir, "inbox"), { recursive: true });
  await mkdir(path.join(runDir, "outbox"), { recursive: true });
  await mkdir(path.join(runDir, "sessions"), { recursive: true });
  const state: RunState = {
    goal: goal!,
    roles,
    context: contextContent,
    maxMinutes: maxMinutes ?? DEFAULT_MAX_MINUTES,
    teams,
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
    `# Run ${ts}-${runName}\n\nGoal: ${goal}\n\nRoles:\n${roles
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

  // -------- 4. Spawn role processes --------
  const children = roles.map((r) => spawnRole(r.name, runDir, false));

  // -------- 5. Main loop --------
  await runLoop({
    runDir,
    roles,
    transcript,
    orch,
    children,
    checkpointMinutes: state.maxMinutes!,
    kickoff: "Begin the run.",
    teamsEnabled: state.teams ?? false,
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
  let checkpointMinutes = state.maxMinutes ?? DEFAULT_MAX_MINUTES;
  if (opts.minutes != null) {
    checkpointMinutes = Math.max(1, Math.min(24 * 60, Math.floor(opts.minutes)));
    await updateState(runDir, { maxMinutes: checkpointMinutes });
    console.log(
      `[orchestrator] checkpoint interval set to ${checkpointMinutes} min on resume (persisted)`
    );
  }

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
}

/** Shared event loop used by both fresh runs and resumes. */
async function runLoop(ctx: LoopCtx): Promise<void> {
  const { runDir, roles, transcript, orch, children, kickoff, teamsEnabled } = ctx;

  // Serialize every orchestrator turn. Outbox watchers fire independently, and
  // each turn does a read-modify-write of the shared ledger — without this,
  // two role replies could interleave and clobber each other's ledger update.
  // The whole critical section (read ledger → send → record cost → write
  // ledger) runs inside the lock. Also tracks whether the last reply carried a
  // ledger, so dispatch knows a no-TO-block turn is legitimate vs. malformed.
  let orchLock: Promise<unknown> = Promise.resolve();
  let lastHadLedger = false;

  /**
   * Run one orchestrator turn. `eventText` is just the new event (a role
   * report, user input, or a nudge); askOrch wraps it with the current ledger.
   * The orchestrator replies with a replacement ledger + TO: blocks; we persist
   * the ledger and return only the TO-block text for dispatch.
   */
  async function askOrch(eventText: string): Promise<string> {
    const task = orchLock.then(async () => {
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
      return extracted.rest;
    });
    orchLock = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  function composeOrchPrompt(ledger: string, eventText: string): string {
    return [
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
    dash.setStatus(`stopping — ${reason}`);
    dash.stop();
    console.log(`\n[orchestrator] stopping (${reason})`);
    await appendTranscript(transcript, "RUN END", reason);
    for (const r of roles) {
      await safeWrite(path.join(runDir, "inbox", `${r.name}.txt`), "exit");
    }
    // Give children a moment to exit cleanly
    setTimeout(() => {
      for (const c of children) {
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
