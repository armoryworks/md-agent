import path from "node:path";
import { readFile } from "node:fs/promises";
import { ClaudeSession } from "./claude.js";
import {
  clearFile,
  isSafeWord,
  readIfReady,
  safeWrite,
  watchFile,
} from "./ipc.js";
import {
  buildRoleHistory,
  readSessionId,
  readState,
  recordUsage,
  resolveModel,
  writeSessionId,
} from "./persist.js";

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

  // Resume strategy: reattach to the stored claude session if we have one;
  // otherwise replay this role's prior turns from the transcript as context.
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

  const model = resolveModel(me.model);
  console.log(`[role:${roleName}] model: ${model}`);
  const session = new ClaudeSession({
    systemPrompt,
    resumeSessionId,
    onSessionId: (id) => void writeSessionId(runDir, roleName, id),
    model,
    heartbeatPath: path.join(runDir, "sessions", `${roleName}.heartbeat`),
  });

  let busy = false;
  let stopped = false;
  let pendingRecheck = false;
  let closeWatcher: () => Promise<void> = async () => {};

  console.log(`[role:${roleName}] ready. Watching ${inbox}`);

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

    const reply = await session.send(content);

    if (session.lastUsage) {
      const total = await recordUsage(runDir, roleName, session.lastUsage);
      console.log(
        `[role:${roleName}] turn $${session.lastUsage.costUsd.toFixed(4)} · run-share $${total.costUsd.toFixed(2)} (${total.turns} turns)`
      );
    }

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
