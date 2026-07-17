import path from "node:path";
import { readFile } from "node:fs/promises";
import { ClaudeSession, type AgentSession } from "./claude.js";
import { GeminiSession } from "./gemini.js";
import {
  clearFile,
  isSafeWord,
  readIfReady,
  safeWrite,
  watchFile,
} from "./ipc.js";
import {
  buildRoleHistory,
  normalizeProvider,
  readSessionId,
  readState,
  recordUsage,
  resolveModelFor,
  writeSessionId,
} from "./persist.js";

/**
 * Opt-in role-session recycling: after this many turns, a claude-backed role
 * writes a short handoff note and is reseeded as a FRESH session (mandate +
 * handoff), so its resident context stops growing without bound. 0/unset = off.
 * The orchestrator's ledger trick, applied to the role seats.
 */
const RECYCLE_TURNS = (() => {
  const n = Number(process.env.MD_AGENT_ROLE_RECYCLE_TURNS);
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

  let session: AgentSession;
  if (provider === "gemini") {
    // Gemini is stateless (v1): no session reattach; the system prompt is re-sent
    // each turn. A resumed gemini role simply starts fresh from its mandate.
    session = new GeminiSession({ systemPrompt, model, heartbeatPath });
  } else {
    // claude — stateful: reattach to the stored session if we have one, otherwise
    // replay this role's prior turns from the transcript as context.
    let resumeSessionId: string | undefined;
    if (opts.resume) {
      const stored = await readSessionId(runDir, roleName);
      if (stored) {
        resumeSessionId = stored;
        console.log(`[role:${roleName}] resuming claude session ${stored}`);
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
    session = new ClaudeSession({
      systemPrompt,
      resumeSessionId,
      onSessionId: (id) => void writeSessionId(runDir, roleName, id),
      model,
      heartbeatPath,
      permissionMode,
    });
  }

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
      `[role:${roleName}] turn $${u.costUsd.toFixed(4)} · ctx ~${Math.round(cacheable / 1000)}k tok · cache ${hitPct}% hit · run-share $${total.costUsd.toFixed(2)} (${total.turns} turns)`
    );
  };

  /**
   * Recycle the session: ask the outgoing session for a concise handoff note,
   * then reseed a FRESH session from the mandate + handoff. Bounds the role's
   * resident context on long runs. Claude-backed roles only (gemini is
   * per-turn stateless already).
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
    session = new ClaudeSession({
      systemPrompt:
        baseSystemPrompt +
        "\n\nHANDOFF FROM YOUR PREVIOUS SESSION (treat as your memory of the run so far):\n" +
        handoff,
      onSessionId: (id) => void writeSessionId(runDir, roleName, id),
      model,
      heartbeatPath,
      permissionMode,
    });
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

    if (RECYCLE_TURNS > 0 && provider === "claude" && turnsSinceSpawn >= RECYCLE_TURNS) {
      await recycleSession();
    }

    const reply = await session.send(content);
    turnsSinceSpawn++;
    await logTurn();

    await safeWrite(outbox, reply);
    return true;
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
    } finally {
      busy = false;
    }
  };

  closeWatcher = watchFile(inbox, handle);
}
