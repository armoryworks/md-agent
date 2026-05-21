import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, ChildProcess } from "node:child_process";
import readline from "node:readline";
import { editor, number } from "@inquirer/prompts";
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
import {
  buildOrchHistory,
  DEFAULT_TIER,
  MODEL_IDS,
  type ModelTier,
  normalizeTier,
  readRunCost,
  readSessionId,
  readState,
  recordUsage,
  type RoleSpec,
  type RunState,
  updateState,
  writeSessionId,
} from "./persist.js";

const DEFAULT_MAX_MINUTES = 10;

/**
 * Compact the orchestrator's session once its context grows past this many
 * tokens (input + cache). Set MD_AGENT_COMPACT_TOKENS=0 to disable.
 */
const COMPACT_TOKENS = (() => {
  const v = process.env.MD_AGENT_COMPACT_TOKENS;
  if (v == null) return 120_000;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
})();

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
    "COORDINATION EFFICIENCY (your context is re-read on every turn — keep it lean):",
    "- Dispatch focused, self-contained instructions. Do NOT paste one role's full output into another role's message — summarize the relevant fact or decision in a sentence or two and point to the shared file if detail is needed.",
    "- Roles report concise STATUS, not full deliverables; their detailed work lives in shared files. Coordinate on those summaries — never ask a role to echo a large artifact back through you.",
    "- Prefer having roles read/write shared files directly over relaying their contents in your messages.",
    "",
    "ROUTING PROTOCOL — STRICT:",
    "Every single one of your responses (except the setup JSON) MUST consist entirely of one or more TO: blocks. Format:",
    "  TO: <role-name>",
    "  <message body to that role>",
    "Multiple blocks per turn are allowed, separated by a line containing only ---.",
    "Do NOT write prose, analysis, summaries, or explanations outside TO: blocks. The framework strips and discards anything outside TO: blocks.",
    "If you have nothing to say to any role, emit nothing — but you must reply with at least one TO: block in normal operation.",
    "When the user wants to terminate the run, the literal single-word message `exit` is sent to all roles.",
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
  const orchSystem = buildOrchSystem({ goal: goal!, roles, context: contextContent });
  const orch = new ClaudeSession({ systemPrompt: orchSystem, model: resolveOrchModel() });

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
  };
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(state, null, 2), "utf8");

  // Persist the orchestrator's session id so the run can be resumed later.
  if (orch.id) await writeSessionId(runDir, "orchestrator", orch.id);

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
    state,
    roles,
    transcript,
    orch,
    children,
    checkpointMinutes: state.maxMinutes!,
    kickoff: "Begin the run.",
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

  // Restore the orchestrator session, or replay its coordination history.
  let orchSystem = buildOrchSystem(state);
  const storedOrch = await readSessionId(runDir, "orchestrator");
  let orch: ClaudeSession;
  if (storedOrch) {
    console.log(`[orchestrator] resuming claude session ${storedOrch}`);
    orch = new ClaudeSession({
      systemPrompt: orchSystem,
      resumeSessionId: storedOrch,
      model: resolveOrchModel(),
      onSessionId: (id) => void writeSessionId(runDir, "orchestrator", id),
    });
  } else {
    const history = buildOrchHistory(
      await readFile(transcript, "utf8"),
      roles.map((r) => r.name)
    );
    if (history) {
      orchSystem +=
        "\n\nThis run is resuming and your previous session could not be reattached. " +
        "Here is the coordination history so far, oldest first. Treat it as your memory " +
        "of what has already happened, then continue from where it leaves off.\n\n" +
        "----- PRIOR COORDINATION -----\n" +
        history +
        "\n----- END PRIOR COORDINATION -----";
      console.log("[orchestrator] no stored session; replaying transcript history");
    } else {
      console.log("[orchestrator] no stored session and no prior history; starting fresh");
    }
    orch = new ClaudeSession({
      systemPrompt: orchSystem,
      model: resolveOrchModel(),
      onSessionId: (id) => void writeSessionId(runDir, "orchestrator", id),
    });
  }

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
    state,
    roles,
    transcript,
    orch,
    children,
    checkpointMinutes,
    kickoff:
      "The run is resuming after a pause. Re-orient using your memory of the run so far, " +
      "then continue coordinating toward the goal. If you were waiting on a role, re-issue the request.",
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
  state: RunState;
  roles: RoleSpec[];
  transcript: string;
  orch: ClaudeSession;
  children: ChildProcess[];
  checkpointMinutes: number;
  kickoff: string;
}

/** Shared event loop used by both fresh runs and resumes. */
async function runLoop(ctx: LoopCtx): Promise<void> {
  const { runDir, state, roles, transcript, children, kickoff } = ctx;
  // Mutable: compaction swaps in a fresh session to cap context growth.
  // Closures below reference this binding, so reassigning it is picked up.
  let orch = ctx.orch;

  // Serialize every orchestrator turn. The outbox watchers fire independently,
  // so without this two role replies could launch concurrent `claude --resume`
  // processes against the same session id and corrupt its history. This also
  // records token cost per turn and tracks context size for compaction.
  let orchLock: Promise<unknown> = Promise.resolve();
  let contextTokens = 0;

  async function askOrch(rawPayload: string): Promise<string> {
    const task = orchLock.then(() => orch.send(rawPayload));
    orchLock = task.then(
      () => undefined,
      () => undefined
    );
    const reply = await task;
    const u = orch.lastUsage;
    if (u) {
      contextTokens = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
      await recordUsage(runDir, "orchestrator", u);
      try {
        const total = await readRunCost(runDir);
        dash.setCost(total.costUsd);
      } catch {
        // Cost display is best-effort; never let it break the run.
      }
    }
    return reply;
  }

  /**
   * When the orchestrator's context grows past COMPACT_TOKENS, roll it into a
   * fresh session seeded with a condensed memory (latest synopsis + recent
   * coordination). Called at checkpoints, where the orchestrator is idle.
   */
  async function maybeCompact(synopsis: string): Promise<void> {
    if (COMPACT_TOKENS === 0 || contextTokens < COMPACT_TOKENS) return;
    // Drain any in-flight orchestrator turn (e.g. a role that replied during
    // the checkpoint pause) so nothing is mid-send when we swap the session.
    await orchLock;
    const approxK = Math.round(contextTokens / 1000);
    dash.setStatus(`compacting orchestrator context (~${approxK}k tok)`);
    console.log(
      `[orchestrator] context ~${contextTokens} tok ≥ ${COMPACT_TOKENS}; rolling session with condensed memory`
    );
    const history = buildOrchHistory(
      await readFile(transcript, "utf8"),
      roles.map((r) => r.name)
    );
    const sys =
      buildOrchSystem(state) +
      "\n\nThis session was COMPACTED to control context size. Below is a condensed memory of " +
      "the run so far — your latest synopsis plus recent coordination, oldest first. Treat it as " +
      "your working memory and continue from where it leaves off. Detailed work lives in the " +
      "shared files referenced throughout.\n\n" +
      "----- LATEST SYNOPSIS -----\n" +
      synopsis.trim() +
      "\n\n----- RECENT COORDINATION -----\n" +
      history +
      "\n----- END -----";
    // No resumeSessionId → starts a fresh claude session; onSessionId persists
    // the new id once its first turn runs. The old session id stays on disk
    // until then, so a crash mid-roll resumes safely (just uncompacted).
    orch = new ClaudeSession({
      systemPrompt: sys,
      model: resolveOrchModel(),
      onSessionId: (id) => void writeSessionId(runDir, "orchestrator", id),
    });
    contextTokens = 0;
    await appendTranscript(
      transcript,
      "ORCH COMPACTED",
      `Context exceeded ${COMPACT_TOKENS} tok; session rolled with condensed memory.`
    );
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
  const firstDispatch = await askOrch(buildOrchMessage(kickoff));
  printOrchReply(firstDispatch);
  await dispatch(firstDispatch);

  // Watch each outbox
  for (const r of roles) {
    const outbox = path.join(runDir, "outbox", `${r.name}.txt`);
    watchFile(outbox, async (content) => {
      if (stopping) return;
      if (isSafeWord(content)) return; // role echoed safe word; nothing to do
      dash.flow(r.name, "orch");
      await appendTranscript(transcript, `← ${r.name}`, content);
      await clearFile(outbox);
      printRoleReply(r.name, content);
      const reply = await askOrch(buildOrchMessage(`[from ${r.name}]\n${content}`));
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
    const reply = await askOrch(buildOrchMessage(`[USER INTERJECTION] ${text}`));
    printOrchReply(reply);
    await dispatch(reply);
  };
  rl.on("line", onInterjection);

  // Wait for exactly one line from the user, with interjections paused.
  const waitOneLine = (): Promise<string> => {
    interjectionsPaused = true;
    return new Promise<string>((res) => {
      const handler = (l: string) => {
        rl.off("line", handler);
        res(l);
      };
      rl.on("line", handler);
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
      dash.setStatus("CHECKPOINT — awaiting your input");
      console.log(`\n[orchestrator] checkpoint — asking for synopsis...`);
      const synopsis = await askOrch(
        "Pause for a checkpoint. Provide a concise synopsis of progress so far and any relevant details for the user. Do not dispatch any TO: blocks in this response."
      );
      await appendTranscript(transcript, "SYNOPSIS", synopsis);
      console.log(`\n----- SYNOPSIS -----\n${synopsis}\n--------------------`);

      // Idle moment — the safest point to roll the session if it has grown large.
      await maybeCompact(synopsis);
      console.log("At this checkpoint you can:");
      console.log("  <feedback>     type feedback then Enter to continue");
      console.log("  (empty)        Enter alone to continue with no feedback");
      console.log(`  extend N       run N more minutes before the NEXT checkpoint only`);
      console.log(`  interval N     change the recurring checkpoint interval to N minutes`);
      console.log("  exit           stop the run");

      const userLine = await waitOneLine();
      const fb = userLine.trim();

      if (isSafeWord(fb)) {
        await stopAll("user typed exit at checkpoint");
        return;
      }

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
        const reply = await askOrch(buildOrchMessage(`[USER FEEDBACK] ${fb}`));
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
    const reply = await askOrch(buildOrchMessage("Continue."));
    printOrchReply(reply);
    await dispatch(reply);
  }

  function buildOrchMessage(payload: string): string {
    return [
      payload,
      "",
      "---",
      `(Reminder: Reply ONLY with one or more TO: blocks. Available roles: ${roles
        .map((r) => r.name)
        .join(", ")}. Format:`,
      "TO: <role-name>",
      "<message>",
      "Separate multiple blocks with a line containing only ---. No prose outside TO: blocks.)",
    ].join("\n");
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
    const blocks = parseDispatch(orchOutput);
    if (blocks.length === 0) {
      await appendTranscript(transcript, "ORCH internal (no TO: blocks)", orchOutput);
      // Nudge the orchestrator to re-emit in protocol.
      console.log("[orchestrator] re-prompting for TO: blocks...");
      const retry = await askOrch(
        buildOrchMessage(
          "Your previous reply contained no TO: blocks. Re-emit your intended action as TO: blocks only."
        )
      );
      const retryBlocks = parseDispatch(retry);
      if (retryBlocks.length === 0) {
        console.warn("[orchestrator] retry also produced no TO: blocks; pausing.");
        await appendTranscript(transcript, "ORCH retry failed", retry);
        return;
      }
      console.log(`[orchestrator] retry produced ${retryBlocks.length} block(s)`);
      for (const b of retryBlocks) await sendToRole(b);
      return;
    }
    for (const b of blocks) await sendToRole(b);
  }

  async function sendToRole(b: { role: string; body: string }): Promise<void> {
    const known = roles.find((r) => r.name === b.role);
    if (!known) {
      console.warn(`[orchestrator] unknown role "${b.role}", skipping`);
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
