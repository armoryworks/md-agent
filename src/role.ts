import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ClaudeSession, ProviderExhaustedError, TurnCappedError, type AgentSession } from "./claude.js";
import { applyFallback, identity, nextRung } from "./heal.js";
import { AgySession } from "./agy.js";
import { provisionWorkspace, workspaceBranch } from "./workspace.js";
import { findSessionByMarker, markerFor, mintSessionId } from "./sessions.js";
import {
  clearFile,
  isSafeWord,
  readIfReady,
  safeWrite,
  watchFile,
} from "./ipc.js";
import {
  appendSessionRecord,
  buildRoleHistory,
  DEFAULT_SEAT_TOOLS,
  DEFAULT_TURN_BUDGET_USD,
  normalizeTier,
  READ_ONLY_SEAT_TOOLS,
  type RoleSpec,
  formatUsage,
  logPath,
  normalizeProvider,
  readSessionId,
  readSessionRecords,
  readState,
  recordUsage,
  resolveModelFor,
  updateState,
  usageTokens,
  writeSessionId,
  writeWindow,
  DEFAULT_ISOLATION,
} from "./persist.js";

/**
 * Role-session recycling: after this many turns, a role writes a short handoff
 * note and is reseeded as a FRESH session (mandate + handoff), so its resident
 * context — and therefore its cache-read cost per turn — stops growing without
 * bound. The orchestrator's ledger trick, applied to the role seats.
 *
 * Defaults ON at DEFAULT_RECYCLE_TURNS: a prior run left this off (unset) and
 * one seat's resident context grew to 1.44M cache-read tokens on a single turn,
 * 53% of a $20.55 run — recycling every N turns bounds that growth instead of
 * requiring an operator to discover the env var after the fact. An explicit
 * MD_AGENT_ROLE_RECYCLE_TURNS always wins, including "0" to opt back out.
 */
// 8, not 20: the run this was drawn from had its worst seat reach 1.44M
// cache-read tokens per turn across EIGHT turns, so a 20-turn threshold would
// never have fired for the very case cited as the reason to turn this on.
//
// Recycling is also only half an answer. In a later run a seat hit 2.4M
// cache-read on its FIRST turn — that cost is the initial context load, which no
// turn-count threshold touches. This bounds growth, not baseline.
const DEFAULT_RECYCLE_TURNS = 8;
const RECYCLE_TURNS = (() => {
  const raw = process.env.MD_AGENT_ROLE_RECYCLE_TURNS;
  if (raw == null) return DEFAULT_RECYCLE_TURNS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
})();

/**
 * Recycle by size as well: when the session's RESIDENT context — what the last
 * model call read, and so what every call of the next turn will re-read — is
 * this large. Measured per call, not summed over the turn: a 40-call turn on a
 * 30k context is busy, not fat, and an earlier version that summed the turn
 * recycled after every substantive turn. MD_AGENT_ROLE_RECYCLE_TOKENS
 * overrides; 0 disables.
 */
const RECYCLE_TOKENS = (() => {
  const raw = process.env.MD_AGENT_ROLE_RECYCLE_TOKENS;
  // 120k, down from 200k: two review runs re-read 45M tokens of context across
  // their calls; the resident context is what every call of a turn pays for.
  if (raw == null) return 120_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
})();

/**
 * The shared brief, for a seat: inline when small; a pointer + excerpt to
 * <runDir>/context.md when large, so it is read on demand instead of riding
 * in the seat's resident context every turn. Same scheme the orchestrator uses.
 */
function roleContextBlock(context: string | undefined, runDir: string): string {
  if (!context) return "";
  const file = path.join(runDir, "context.md");
  if (context.length <= 2000 || !existsSync(file)) return `\nShared context:\n${context}`;
  return [
    "",
    `Shared context: the full ${Math.max(1, Math.round(context.length / 1000))} KB brief is at ${file} — read it (or the section you need) with your file tools when your work depends on it. Do not paste it back into reports.`,
    "Opening excerpt:",
    context.slice(0, 600) + (context.length > 600 ? "\n…[truncated — full text in the file]" : ""),
  ].join("\n");
}

/** The built-in tools a seat gets: read-only set, its own list, or the default. */
export function seatTools(me: Pick<RoleSpec, "readOnly" | "tools">): string[] {
  if (me.readOnly) return READ_ONLY_SEAT_TOOLS;
  return me.tools ?? DEFAULT_SEAT_TOOLS;
}

/** A claude seat's per-turn USD cap: its own, else the tier default; 0 = none. */
export function seatTurnBudget(me: Pick<RoleSpec, "turnBudgetUsd" | "model">): number | undefined {
  if (me.turnBudgetUsd != null) return me.turnBudgetUsd > 0 ? me.turnBudgetUsd : undefined;
  const env = Number(process.env.MD_AGENT_TURN_BUDGET_USD);
  if (Number.isFinite(env)) return env > 0 ? env : undefined;
  const tier = me.model && me.model in DEFAULT_TURN_BUDGET_USD ? normalizeTier(me.model) : null;
  return tier ? DEFAULT_TURN_BUDGET_USD[tier] : undefined;
}

export async function runRole(
  roleName: string,
  runDir: string,
  opts: { resume?: boolean } = {}
): Promise<void> {
  const state = await readState(runDir);
  const me = state.roles.find((r) => r.name === roleName);
  if (!me) throw new Error(`Role "${roleName}" not found in state.json`);

  const inbox = path.join(runDir, "inbox", `${roleName}.txt`);
  const outbox = path.join(runDir, "outbox", `${roleName}.txt`);
  const transcript = path.join(runDir, "transcript.md");

  // The seat's identity can change mid-run (auto-heal onto a fallback provider),
  // so these are recomputed from `me` rather than fixed at spawn.
  let provider = normalizeProvider(me.provider);
  let model = resolveModelFor(provider, me.model);
  let turnCapSec = me.turnTimeoutSec ?? (provider === "agy" ? 300 : 600);
  const refreshIdentity = (): void => {
    provider = normalizeProvider(me.provider);
    model = resolveModelFor(provider, me.model);
    turnCapSec = me.turnTimeoutSec ?? (provider === "agy" ? 300 : 600);
  };
  const runName = path.basename(runDir);
  const repoDir = process.cwd();

  // Where this seat's file edits land. An explicit RoleSpec.cwd wins; otherwise
  // isolation decides — "worktree" hands the seat its own checkout so its output
  // can be reviewed and kept or dropped, "none" shares md-agent's cwd.
  const workspaceDir =
    me.cwd ??
    (await provisionWorkspace({
      isolation: state.isolation ?? DEFAULT_ISOLATION,
      repoDir,
      runDir,
      runName,
      role: roleName,
    }));
  if (workspaceDir) console.log(`[role:${roleName}] workspace: ${workspaceDir}`);

  // The seat is told the same check the gate runs and where its tree is — a
  // seat that runs a different command, or edits the repo root from a
  // worktree, is the failure both of these lines exist to prevent.
  const verifySpec = me.verify === false ? undefined : (me.verify ?? state.verify);
  const isolated = (state.isolation ?? DEFAULT_ISOLATION) === "worktree" && !me.cwd;
  const siblingsDir = path.join(runDir, "workspaces");
  const placeLines = workspaceDir
    ? [
        `Your workspace: ${workspaceDir}` +
          (isolated ? ` (git branch ${workspaceBranch(runName, roleName)}, a worktree of ${repoDir})` : "") +
          `. Every file you read or edit and every command you run is there. Never edit ${repoDir} itself.`,
        ...(isolated
          ? [
              `Other seats' work: each seat has its own worktree under ${siblingsDir}/<seat> (read-only for you — never edit another seat's tree) and, once verified, its commits on branch md-agent/${runName}/<seat> in the shared repo. Read a sibling's file directly from its worktree, or \`git show md-agent/${runName}/<seat>:<path>\` from yours. Nothing appears in your own tree until you merge it.`,
              `Your verified replies are committed on your branch by the harness; you may also commit yourself.`,
            ]
          : []),
      ]
    : [];
  const verifyLines = verifySpec
    ? [
        `The run's check is exactly: \`${verifySpec.cmd}\` — run that (in your workspace) before reporting done; it is what your reply will be judged by.`,
        "When a reply is READY to be judged by that check — the deliverable is in place — end it with the line VERIFY-READY on its own. An interim status (a slice done, notes written, a question) must not carry that line; it is reported as-is and never bounced.",
      ]
    : me.verify === false
      ? ["This seat produces no artifact the run's verify command checks; report findings, not passes."]
      : [];

  const turnBudget = provider === "claude" ? seatTurnBudget(me) : undefined;
  let systemPrompt = [
    `You are the "${roleName}" agent.`,
    `Your role: ${me.description}`,
    `The overall goal: ${state.goal}`,
    ...placeLines,
    ...verifyLines,
    "",
    "You receive messages from an orchestrator. Reply with the content you want sent back to the orchestrator. Do not include role tags or routing headers — just your answer.",
    "",
    "REPORTING DISCIPLINE (keep token cost down — every word you send is re-read by the orchestrator on every later turn):",
    "- Your reply to the orchestrator is a STATUS REPORT, not the deliverable itself.",
    "- Put detailed work — documents, findings, specs, code — in files in the workspace and REFERENCE them by path. Do NOT paste large file contents, full logs, or long listings back to the orchestrator.",
    "- Target 250 words or fewer: what you did, what you found or decided, what you need next, and file pointers. Expand beyond that only when the orchestrator explicitly asks for a full deliverable inline.",
    "",
    "TURN DISCIPLINE (a turn is one agentic loop; every call in it re-reads everything so far — long turns are where quota goes):",
    "- Do ONE slice of the ask per turn: a few files, one change, one check. Run the verify or test once, then REPORT. You will be dispatched again for the next slice.",
    "- Never re-read the whole repository or re-run the full suite to \"confirm\" something you already established this run — trust your earlier turn's finding and say so.",
    `- A turn is capped at ${turnCapSec}s${turnBudget ? ` and $${turnBudget}` : ""}; if you are near it, stop and report what is done and what is next.`,
    "",
    "READ DISCIPLINE (tool output is three quarters of what you re-read on every call — what you print, you pay for on every later call this turn):",
    "- Never print a whole file. Read with an offset and a limit, or grep -n with a line budget (`| head -40`); open only the lines a finding needs.",
    "- Never dump a listing or a log: `wc -l`, `head`, `grep -c` first, then the slice that matters.",
    "- Checking many items (citations, anchors, rows): BATCH them — one grep with an alternation, or one script over the list that prints only pass/fail per item — never one call per item.",
    "- Write big content to files with one command, not in pieces; do not echo it back.",
    ...(me.readOnly ? ["- This seat is READ-ONLY: Read, Grep and Glob only — no shell, no writes. Report findings in your reply; cite file:line."] : []),
    roleContextBlock(state.context, runDir),
  ]
    .filter(Boolean)
    .join("\n");
  // The un-augmented mandate — what a recycled session is reseeded from (the
  // resume path may append transcript history to systemPrompt below).
  const baseSystemPrompt = systemPrompt;

  const heartbeatPath = path.join(runDir, "sessions", `${roleName}.heartbeat`);
  const permissionMode =
    me.permissionMode ?? process.env.MD_AGENT_ROLE_PERMISSION_MODE?.trim() ?? undefined;
  console.log(
    `[role:${roleName}] provider: ${provider}, model: ${model}` +
      (permissionMode ? `, permission-mode: ${permissionMode}` : "")
  );

  // Session lineage: generation 0 is the first session, +1 per recycle. Each
  // generation has a marker in its first prompt and (claude) a minted id, so a
  // resume can name the session — or find it in the CLI's store by the marker.
  const records = await readSessionRecords(runDir, roleName);
  let gen = records.length ? records[records.length - 1].gen : 0;
  if (!opts.resume && records.length) gen++; // a deliberately fresh session after earlier ones (escalation with MD_AGENT_ESCALATION_FRESH)
  const recorded = new Set(records.map((r) => r.id));
  const noteSession = (id: string, g: number): void => {
    void writeSessionId(runDir, roleName, id);
    if (recorded.has(id)) return;
    recorded.add(id);
    void appendSessionRecord(runDir, roleName, { gen: g, provider, id, at: new Date().toISOString() });
  };

  // Both providers are stateful (claude --resume, agy --conversation), so the
  // resume handling is shared: reattach the stored session id when there is one,
  // else search the provider's own store for this seat's marker, else replay
  // this role's prior turns into its mandate as memory.
  let resumeSessionId: string | undefined;
  if (opts.resume) {
    const stored = await readSessionId(runDir, roleName);
    const found = stored ? null : await findSessionByMarker(provider, runName, roleName).catch(() => null);
    if (stored) {
      resumeSessionId = stored;
      console.log(`[role:${roleName}] resuming ${provider} session ${stored}`);
    } else if (found) {
      resumeSessionId = found.id;
      gen = found.gen;
      noteSession(found.id, found.gen);
      console.log(`[role:${roleName}] no stored id — found ${provider} session ${found.id} by its marker (gen ${found.gen})`);
    } else {
      gen = records.length ? gen + 1 : 0;
      const history = buildRoleHistory(await readFile(transcript, "utf8"), roleName);
      if (history) {
        systemPrompt +=
          "\n\nThis run is resuming and your previous session could not be reattached. " +
          "Here is the prior conversation between you and the orchestrator, oldest first. " +
          "Treat it as your memory of what has already happened, then continue from where it leaves off.\n\n" +
          "----- PRIOR CONVERSATION -----\n" +
          history +
          "\n----- END PRIOR CONVERSATION -----";
        console.log(`[role:${roleName}] no stored session; replaying transcript history`);
      } else {
        console.log(`[role:${roleName}] no stored session and no prior history; starting fresh`);
      }
    }
  }

  /**
   * Build a seat for this role. Used for both the initial session and recycling,
   * so the two cannot drift on provider, model or permission posture. The
   * prompt opens with this generation's marker; a claude seat also starts on
   * its minted id, recorded before the turn runs.
   */
  const makeSession = (prompt: string, resumeId?: string): AgentSession => {
    const marker = markerFor(runName, roleName, gen);
    const common = {
      model,
      heartbeatPath,
      permissionMode,
      cwd: workspaceDir,
      logPath: logPath(runDir, roleName),
      turnTimeoutSec: turnCapSec,
      effort: me.effort,
    };
    const onSessionId = (id: string) => noteSession(id, gen);
    if (provider === "agy") {
      return new AgySession({ systemPrompt: `${marker}\n${prompt}`, resumeId, onSessionId, turnMaxSteps: me.turnMaxSteps, ...common });
    }
    const sessionId = resumeId ? undefined : mintSessionId(runName, roleName, gen);
    if (sessionId) noteSession(sessionId, gen);
    return new ClaudeSession({
      systemPrompt: `${marker}\n${prompt}`,
      resumeSessionId: resumeId,
      sessionId,
      onSessionId,
      tools: seatTools(me),
      noMcp: (me.mcp ?? "none") === "none",
      noSkills: me.skills !== true,
      maxBudgetUsd: seatTurnBudget(me),
      fallbackModel: me.fallbackModel,
      addDirs: isolated ? [siblingsDir] : undefined,
      settingSources: me.projectInstructions === false ? "user" : undefined,
      ...common,
    });
  };

  let session: AgentSession = makeSession(systemPrompt, resumeSessionId);

  let busy = false;
  let stopped = false;
  let pendingRecheck = false;
  let turnsSinceSpawn = 0;
  let closeWatcher: () => Promise<void> = async () => {};

  console.log(`[role:${roleName}] ready. Watching ${inbox}`);

  const logTurn = async (): Promise<void> => {
    const u = session.lastUsage;
    if (!u) return;
    const total = await recordUsage(runDir, roleName, u);
    // ctx ≈ the full resident prompt this turn (cached + uncached input). Watching
    // it grow — and the hit% go cold on sparse cadence — is the data that says
    // when MD_AGENT_ROLE_RECYCLE_TURNS is worth turning on.
    const cacheable = u.cacheReadTokens + u.cacheCreationTokens + u.inputTokens;
    const hitPct = cacheable > 0 ? Math.round((u.cacheReadTokens / cacheable) * 100) : 0;
    console.log(
      `[role:${roleName}] turn $${u.costUsd.toFixed(4)} · ${formatUsage(u)} · ${Math.round(usageTokens(u) / 1000)}k tok · cache ${hitPct}% hit` +
        `  ‖  net $${total.costUsd.toFixed(2)} · ${formatUsage(total)} · ${Math.round(usageTokens(total) / 1000)}k tok (${total.turns} turns)`
    );
    const w = session.lastWindows;
    if (w) {
      await writeWindow(runDir, roleName, w);
      const pct = (x?: { utilization: number }) => (x ? `${Math.round(x.utilization * 100)}%` : "—");
      console.log(`[role:${roleName}] plan windows · 5h ${pct(w.fiveHour)} · 7d ${pct(w.sevenDay)}`);
    }
  };

  /**
   * Recycle the session: ask the outgoing session for a concise handoff note,
   * then reseed a FRESH session from the mandate + handoff. Bounds the role's
   * resident context on long runs. Applies to both providers — claude and agy
   * are each stateful, so each accumulates context across turns.
   */
  const recycleSession = async (): Promise<void> => {
    console.log(
      `[role:${roleName}] recycling session after ${turnsSinceSpawn} turns (MD_AGENT_ROLE_RECYCLE_TURNS=${RECYCLE_TURNS})`
    );
    const handoff = await session.send(
      "You are being recycled to keep this run's context bounded. Write a handoff note " +
        "to your successor (a fresh session of yourself, same role and goal). Include: the " +
        "current state of your work, key decisions made and why, file paths to everything " +
        "you produced or rely on, and gotchas the successor must know. 300 words or fewer. " +
        "Reply with ONLY the note."
    );
    await logTurn();
    gen++;
    session = makeSession(
      baseSystemPrompt +
        "\n\nHANDOFF FROM YOUR PREVIOUS SESSION (treat as your memory of the run so far):\n" +
        handoff
    );
    turnsSinceSpawn = 0;
  };

  const processOne = async (content: string): Promise<boolean> => {
    if (isSafeWord(content)) {
      await clearFile(inbox);
      stopped = true;
      console.log(`[role:${roleName}] exit received, shutting down.`);
      await closeWatcher();
      process.exit(0);
    }

    // The orchestrator is the sole transcript writer (it sees both directions),
    // so roles no longer append here — that previously double-logged every
    // message. We only consume the inbox and reply via the outbox.
    await clearFile(inbox);

    // Both providers are stateful now, so recycling is no longer claude-only.
    // By turn count, or by size: the resident context every call of this turn
    // would re-read.
    const resident = session.lastContextTokens ?? 0;
    if ((RECYCLE_TURNS > 0 && turnsSinceSpawn >= RECYCLE_TURNS) || (RECYCLE_TOKENS > 0 && resident >= RECYCLE_TOKENS)) {
      if (resident >= RECYCLE_TOKENS) console.log(`[role:${roleName}] resident context is ${Math.round(resident / 1000)}k tokens (≥ ${Math.round(RECYCLE_TOKENS / 1000)}k) — recycling before this turn`);
      await recycleSession();
    }

    const reply = await session.send(content);
    turnsSinceSpawn++;
    await logTurn();

    // A seat that answers with nothing must not look like a seat that answered.
    // An empty outbox raises no event, so the orchestrator would carry on as
    // though this role had reported — the failure would be invisible in the
    // transcript and the run could complete without it.
    if (!reply.trim()) {
      const msg =
        `[role:${roleName}] EMPTY REPLY from ${provider} — reporting it rather than ` +
        `writing an empty outbox the orchestrator would never see.`;
      console.warn(msg);
      await safeWrite(
        outbox,
        `[ROLE ERROR] ${roleName} (${provider}/${model}) returned an empty reply. ` +
          `Nothing was produced for this dispatch. If this seat must run commands, it ` +
          `needs permissionMode "bypassPermissions" — headless mode cannot prompt, so ` +
          `tool calls are auto-denied and the reply comes back empty.`
      );
      return true;
    }

    await safeWrite(outbox, healNote ? `${healNote}\n\n${reply}` : reply);
    healNote = null;
    return true;
  };

  /** Prepended to the next reply so the orchestrator learns the seat moved. */
  let healNote: string | null = null;

  /**
   * Auto-heal: the provider ran dry mid-turn. Move down the seat's fallback
   * ladder (its own, else the run's), record the move in state.json so a resume
   * and the orchestrator see the new identity, and reseed a FRESH session on the
   * new provider from the mandate plus this seat's transcript history — the old
   * session cannot be asked for a handoff, its provider is the thing that failed.
   * Returns false when there is no rung left, and the seat stops itself as before.
   */
  const healSelf = async (err: ProviderExhaustedError): Promise<boolean> => {
    const rung = nextRung(me, err.provider, state.fallback);
    if (!rung) return false;
    const rec = applyFallback(me, rung, err.message, err.resetsAt);
    try {
      const cur = await readState(runDir);
      const mine = cur.roles.find((r) => r.name === roleName);
      if (mine) {
        mine.provider = me.provider;
        mine.model = me.model;
        mine.healed = me.healed;
        mine.turnTimeoutSec = me.turnTimeoutSec;
        mine.turnMaxSteps = me.turnMaxSteps;
        await updateState(runDir, { roles: cur.roles });
      }
    } catch {
      // state is best-effort; the reply's heal note still reaches the orchestrator
    }
    refreshIdentity();
    const resetNote = err.resetsAt
      ? ` (it resets ${new Date(err.resetsAt * 1000).toISOString()})`
      : "";
    console.warn(
      `[role:${roleName}] ${rec.from.provider} ran dry${resetNote} — healing onto ${identity(rec.to)} (rung ${me.healed?.length ?? 1})`
    );
    gen++;
    let seed = baseSystemPrompt +
      `\n\nYOU WERE MOVED HERE MID-RUN: your previous session ran on ${identity(rec.from)}, which ran out of quota. ` +
      "You are a fresh session of the same role on a different provider. Nothing of the previous session's working memory survives except what is below and what is on disk in your workspace — re-read files rather than assume.";
    try {
      const history = buildRoleHistory(await readFile(transcript, "utf8"), roleName);
      if (history) {
        seed += "\n\n----- PRIOR CONVERSATION (your memory of the run so far) -----\n" + history + "\n----- END PRIOR CONVERSATION -----";
      }
    } catch {
      // no transcript yet — the mandate alone seeds the new session
    }
    session = makeSession(seed);
    turnsSinceSpawn = 0;
    healNote =
      `[SEAT HEALED] "${roleName}" moved from ${identity(rec.from)} to ${identity(rec.to)} — ${rec.from.provider} ran out of quota${resetNote}. ` +
      "It was reseeded from its transcript history; this reply is from the new seat. Keep dispatching to it as before.";
    return true;
  };

  /**
   * Out of quota: mark this seat stopped in state.json (so the orchestrator
   * neither dispatches to it nor respawns it), tell the orchestrator through
   * the outbox, and exit. The same shape as a user stop, with the reset time.
   */
  const stopSelf = async (err: ProviderExhaustedError): Promise<void> => {
    const resetNote = err.resetsAt
      ? ` It resets in ~${Math.max(1, Math.round((err.resetsAt * 1000 - Date.now()) / 3600000))}h (${new Date(err.resetsAt * 1000).toISOString()}).`
      : "";
    console.error(`[role:${roleName}] ${provider} is out of quota — stopping this seat.${resetNote}`);
    try {
      const cur = await readState(runDir);
      const mine = cur.roles.find((r) => r.name === roleName);
      if (mine) {
        mine.stopped = { at: new Date().toISOString(), reason: `${provider} exhausted: ${err.message}`, resetsAt: err.resetsAt };
        await updateState(runDir, { roles: cur.roles });
      }
    } catch {
      // state is best-effort; the outbox note still gets the orchestrator to re-plan
    }
    await safeWrite(
      outbox,
      `[SEAT STOPPED] "${roleName}" (${provider}/${model}) is OUT OF QUOTA and has stopped itself: ${err.message}.${resetNote} ` +
        `Its work is ABANDONED. Never dispatch to "${roleName}" again in this run; reassign its outstanding work to another seat or drop it. Update Role status.`
    );
    stopped = true;
    await closeWatcher();
    process.exit(0);
  };

  const handle = async (initialContent: string): Promise<void> => {
    if (stopped) return;
    if (busy) {
      pendingRecheck = true;
      return;
    }
    busy = true;
    let content: string | null = initialContent;
    try {
      while (content !== null && !stopped) {
        pendingRecheck = false;
        // A dry provider is healed and the same dispatch re-run on the new seat;
        // the ladder is consumed one rung per failure, so this cannot loop.
        for (;;) {
          try {
            await processOne(content);
            break;
          } catch (err) {
            if (err instanceof ProviderExhaustedError && (await healSelf(err))) continue;
            throw err;
          }
        }
        if (pendingRecheck) {
          content = await readIfReady(inbox);
        } else {
          content = null;
        }
      }
    } catch (err) {
      console.error(`[role:${roleName}] error:`, err);
      // A turn that failed still spent: book what the CLI reported so the run's
      // Σ is the truth (a $3 capped turn was invisible before this).
      turnsSinceSpawn++;
      await logTurn().catch(() => {});
      // A silent seat strands the orchestrator until the watchdog gives up on
      // it; a seat that says what went wrong lets it re-plan now.
      if (err instanceof ProviderExhaustedError) {
        await stopSelf(err);
        return;
      }
      try {
        if (err instanceof TurnCappedError) {
          const where = workspaceDir ? ` in ${workspaceDir}` : "";
          await safeWrite(
            outbox,
            `[TURN CAPPED] ${roleName} (${provider}/${model}) was stopped by its ${err.kind === "budget" ? "per-turn budget" : err.kind === "timeout" ? "turn time cap" : "turn cap"}: ${err.message.split("\n")[0].slice(0, 300)}. ` +
              `This is NOT a failure of the work — the seat was mid-task. Any files it wrote before the cap are on disk${where} (possibly partial, uncommitted). ` +
              `Re-dispatch it with a SMALLER ask (one slice), telling it to check what it already wrote first; or raise the cap.`
          );
          return;
        }
        await safeWrite(
          outbox,
          `[ROLE ERROR] ${roleName} (${provider}/${model}) could not complete this turn: ${(err as Error).message.split("\n")[0].slice(0, 300)}. ` +
            `Re-dispatch if it should retry, or route the work elsewhere.`
        );
      } catch {
        // nothing more to do
      }
    } finally {
      busy = false;
    }
  };

  closeWatcher = watchFile(inbox, handle);
}
