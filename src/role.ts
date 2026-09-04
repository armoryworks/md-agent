import path from "node:path";
import { readFile } from "node:fs/promises";
import { ClaudeSession, ProviderExhaustedError, type AgentSession } from "./claude.js";
import { AgySession } from "./agy.js";
import { provisionWorkspace } from "./workspace.js";
import {
  clearFile,
  isSafeWord,
  readIfReady,
  safeWrite,
  watchFile,
} from "./ipc.js";
import {
  buildRoleHistory,
  formatUsage,
  logPath,
  normalizeProvider,
  readSessionId,
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

  let systemPrompt = [
    `You are the "${roleName}" agent.`,
    `Your role: ${me.description}`,
    `The overall goal: ${state.goal}`,
    "",
    "You receive messages from an orchestrator. Reply with the content you want sent back to the orchestrator. Do not include role tags or routing headers — just your answer.",
    "",
    "REPORTING DISCIPLINE (keep token cost down — every word you send is re-read by the orchestrator on every later turn):",
    "- Your reply to the orchestrator is a STATUS REPORT, not the deliverable itself.",
    "- Put detailed work — documents, findings, specs, code — in files in the workspace and REFERENCE them by path. Do NOT paste large file contents, full logs, or long listings back to the orchestrator.",
    "- Target 250 words or fewer: what you did, what you found or decided, what you need next, and file pointers. Expand beyond that only when the orchestrator explicitly asks for a full deliverable inline.",
    state.context ? `\nShared context:\n${state.context}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // The un-augmented mandate — what a recycled session is reseeded from (the
  // resume path may append transcript history to systemPrompt below).
  const baseSystemPrompt = systemPrompt;

  const provider = normalizeProvider(me.provider);
  const model = resolveModelFor(provider, me.model);
  const heartbeatPath = path.join(runDir, "sessions", `${roleName}.heartbeat`);
  const permissionMode =
    me.permissionMode ?? process.env.MD_AGENT_ROLE_PERMISSION_MODE?.trim() ?? undefined;
  console.log(
    `[role:${roleName}] provider: ${provider}, model: ${model}` +
      (permissionMode ? `, permission-mode: ${permissionMode}` : "")
  );

  // Both providers are stateful (claude --resume, agy --conversation), so the
  // resume handling is shared: reattach the stored session id when there is one,
  // otherwise replay this role's prior turns into its mandate as memory.
  let resumeSessionId: string | undefined;
  if (opts.resume) {
    const stored = await readSessionId(runDir, roleName);
    if (stored) {
      resumeSessionId = stored;
      console.log(`[role:${roleName}] resuming ${provider} session ${stored}`);
    } else {
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

  // Where this seat's file edits land. An explicit RoleSpec.cwd wins; otherwise
  // isolation decides — "worktree" hands the seat its own checkout so its output
  // can be reviewed and kept or dropped, "none" shares md-agent's cwd.
  const workspaceDir =
    me.cwd ??
    (await provisionWorkspace({
      isolation: state.isolation ?? DEFAULT_ISOLATION,
      repoDir: process.cwd(),
      runDir,
      runName: path.basename(runDir),
      role: roleName,
    }));
  if (workspaceDir) console.log(`[role:${roleName}] workspace: ${workspaceDir}`);

  /**
   * Build a seat for this role. Used for both the initial session and recycling,
   * so the two cannot drift on provider, model or permission posture.
   */
  const makeSession = (prompt: string, resumeId?: string): AgentSession => {
    const common = {
      model,
      heartbeatPath,
      permissionMode,
      cwd: workspaceDir,
      logPath: logPath(runDir, roleName),
    };
    const onSessionId = (id: string) => void writeSessionId(runDir, roleName, id);
    return provider === "agy"
      ? new AgySession({ systemPrompt: prompt, resumeId, onSessionId, ...common })
      : new ClaudeSession({
          systemPrompt: prompt,
          resumeSessionId: resumeId,
          onSessionId,
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
    if (RECYCLE_TURNS > 0 && turnsSinceSpawn >= RECYCLE_TURNS) {
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

    await safeWrite(outbox, reply);
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
        await processOne(content);
        if (pendingRecheck) {
          content = await readIfReady(inbox);
        } else {
          content = null;
        }
      }
    } catch (err) {
      console.error(`[role:${roleName}] error:`, err);
      // A silent seat strands the orchestrator until the watchdog gives up on
      // it; a seat that says what went wrong lets it re-plan now.
      if (err instanceof ProviderExhaustedError) {
        await stopSelf(err);
        return;
      }
      try {
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
