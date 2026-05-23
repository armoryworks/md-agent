import path from "node:path";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { ClaudeSession } from "./claude.js";
import {
  MODEL_IDS,
  type ModelTier,
  recordUsage,
  type RoleSpec,
} from "./persist.js";

/**
 * One phase of a journey — the same shape as a launch config, minus the
 * run-dir/context-resolution bookkeeping the driver fills in. `roles` may omit
 * names/models (the orchestrator bootstraps them) or pin them for a
 * deterministic, zero-cost start.
 */
export interface JourneyPhase {
  /** Stable id — names the run dir and the handshake folder `phases/<id>/`. */
  id: string;
  goal: string;
  roles: RoleSpec[];
  /** Path (relative to the manifest) to a context doc included whole. */
  context?: string;
  maxMinutes?: number;
  teams?: boolean;
  budgetMinutes?: number;
  /** Pause for handshake review before this phase. Default true (never for the first). */
  pauseBefore?: boolean;
  /**
   * Let the phase end itself when its goal is met instead of idling until the
   * budget. Default ON for journey phases (a finished phase hands off at once);
   * set false for an open-ended phase you want to babysit to a manual `exit`.
   */
  autoComplete?: boolean;
}

/** A templated multi-phase run, authored up front before phase 0 executes. */
export interface Journey {
  name: string;
  phases: JourneyPhase[];
}

/**
 * Run a templated journey: each phase executes as its own child orchestrator
 * (full console UI), and when a phase finishes the driver authors a PARTING
 * HANDSHAKE from that phase's ledger into the downstream phase folder(s) — the
 * immediate next always, plus any later phase the outcome materially changes.
 * Before each non-first phase it pauses so you can read the handshake and edit
 * the manifest / phase folder; the launch picks up your edits live.
 */
export async function runJourney(manifestPath: string): Promise<void> {
  const manifestAbs = path.resolve(manifestPath);
  const dir = path.dirname(manifestAbs);

  const readManifest = async (): Promise<Journey> => {
    const j = JSON.parse(await readFile(manifestAbs, "utf8")) as Journey;
    if (!j.name || !Array.isArray(j.phases) || j.phases.length === 0) {
      throw new Error(`Journey ${manifestPath} needs a "name" and a non-empty "phases" array.`);
    }
    const ids = new Set<string>();
    for (const p of j.phases) {
      if (!p.id) throw new Error(`Journey ${manifestPath}: every phase needs an "id".`);
      if (ids.has(p.id)) throw new Error(`Journey ${manifestPath}: duplicate phase id "${p.id}".`);
      ids.add(p.id);
    }
    return j;
  };

  let journey = await readManifest();
  const total = journey.phases.length;
  console.log(
    `\n[journey] "${journey.name}" — ${total} phase(s): ${journey.phases.map((p) => p.id).join(" → ")}\n`
  );

  // Every phase gets a folder for the handshake(s) addressed to it.
  for (const p of journey.phases) {
    await mkdir(path.join(dir, "phases", p.id), { recursive: true });
  }

  for (let i = 0; i < total; i++) {
    journey = await readManifest(); // live re-read so manifest edits take effect
    let phase = journey.phases[i];

    if (i > 0 && phase.pauseBefore !== false) {
      const decision = await reviewPause(dir, phase, i, total);
      if (decision === "exit") {
        console.log("[journey] aborted by user.");
        return;
      }
      if (decision === "skip") {
        console.log(`[journey] skipping phase ${phase.id}.`);
        continue;
      }
      journey = await readManifest(); // pick up edits made during the pause
      phase = journey.phases[i];
    }

    const runDir = path.resolve("runs", `journey-${journey.name}-${pad(i)}-${phase.id}`);
    const inboxAbs = path.join(dir, "phases", phase.id, "INBOX.md");
    const cfg = {
      name: phase.id,
      goal: phase.goal,
      roles: phase.roles,
      context: phase.context, // already relative to the manifest dir
      inbox: existsSync(inboxAbs)
        ? path.relative(dir, inboxAbs).split(path.sep).join("/")
        : undefined,
      maxMinutes: phase.maxMinutes,
      teams: phase.teams,
      budgetMinutes: phase.budgetMinutes,
      // Journey phases self-terminate when done so the journey advances without
      // a human typing `exit` at every phase end. Opt out per phase with false.
      autoComplete: phase.autoComplete ?? true,
      runDir,
    };
    const cfgPath = path.join(dir, ".phase.launch.json");
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

    console.log(`\n[journey] ── phase ${i + 1}/${total}: ${phase.id} ─────────────────────\n`);
    await spawnPhase(cfgPath);
    console.log(`\n[journey] phase ${phase.id} ended.\n`);

    // Crash guard: an empty ledger means the orchestrator never took a turn — the
    // phase crashed at startup (commonly the claude CLI being unavailable or
    // rate-limited). Do NOT advance, or the remaining phases cascade through as
    // instant no-ops. Halt so the run can be resumed once the cause clears.
    const ledgerFile = path.join(runDir, "ledger.md");
    const ledgerLen = existsSync(ledgerFile) ? (await readFile(ledgerFile, "utf8")).trim().length : 0;
    if (ledgerLen === 0) {
      console.error(
        `\n[journey] HALT: phase "${phase.id}" produced no ledger — its orchestrator never ran ` +
          `(startup crash, often claude unavailable/rate-limited). Stopping instead of cascading ` +
          `through the remaining phases as no-ops. Re-run the journey (or a from-<id> manifest) ` +
          `once the cause clears.\n`
      );
      return;
    }

    if (i < total - 1) {
      await writeHandshakes(dir, journey, i, runDir);
    }
  }

  console.log(`\n[journey] "${journey.name}" complete — ${total} phases finished.\n`);
}

function pad(i: number): string {
  return String(i).padStart(2, "0");
}

/** Run one phase as a child `--launch` process; resolve when it exits. */
function spawnPhase(cfgPath: string): Promise<void> {
  const entry = process.argv[1];
  const isTs = entry.endsWith(".ts");
  const args = [...(isTs ? ["--import", "tsx", entry] : [entry]), "--launch", cfgPath];
  return new Promise<void>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.on("exit", () => resolve());
    child.on("error", (e) => {
      console.error(`[journey] phase spawn error: ${e.message}`);
      resolve();
    });
  });
}

type PauseDecision = "go" | "skip" | "exit";

/** Show the handshake addressed to the upcoming phase + its roles, then wait. */
async function reviewPause(
  dir: string,
  phase: JourneyPhase,
  i: number,
  total: number
): Promise<PauseDecision> {
  const inboxFile = path.join(dir, "phases", phase.id, "INBOX.md");
  let handshake = "(no handshake was written for this phase)";
  if (existsSync(inboxFile)) {
    const c = (await readFile(inboxFile, "utf8")).trim();
    if (c) handshake = c;
  }
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  HANDSHAKE → phase ${i + 1}/${total}: ${phase.id}`);
  console.log("═".repeat(70));
  console.log(handshake);
  console.log(`\n  Roles for ${phase.id}:`);
  for (const r of phase.roles) {
    const nm = r.name ?? "(auto-named)";
    const md = r.model ? ` [${r.model}]` : "";
    console.log(`    • ${nm}${md}: ${r.description}`);
  }
  console.log(
    `\n  Edit the manifest or phases/${phase.id}/ now if you want — changes are picked up on launch.`
  );
  console.log(
    `  [Enter] launch  ·  "skip" skip this phase  ·  "exit" stop the journey`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question("  > ")).trim().toLowerCase();
  rl.close();
  if (ans === "exit") return "exit";
  if (ans === "skip") return "skip";
  return "go";
}

interface HandshakeBlock {
  phase: string;
  body: string;
}

/**
 * Author handshake(s) from the just-finished phase's ledger into downstream
 * phase folder(s). Always the immediate next phase; additionally any later
 * phase whose plan the outcome materially changes (multi-stage propagation).
 */
async function writeHandshakes(
  dir: string,
  journey: Journey,
  justFinished: number,
  runDir: string
): Promise<void> {
  const downstream = journey.phases.slice(justFinished + 1);
  if (downstream.length === 0) return;
  const finished = journey.phases[justFinished];
  const next = downstream[0];

  const ledgerFile = path.join(runDir, "ledger.md");
  const ledger = existsSync(ledgerFile) ? (await readFile(ledgerFile, "utf8")).trim() : "";

  const sys = [
    "You author a concise PARTING HANDSHAKE from a just-finished phase of a multi-phase journey to the phase(s) that follow.",
    "You are given the finished phase's ledger (its full working memory) and the downstream phases with their goals and roles.",
    "Always write a handshake for the IMMEDIATE next phase. ADDITIONALLY write one for any LATER phase whose plan or roles this phase's outcome materially changes — but only when the downstream effect genuinely warrants it. Do not pad.",
    "",
    "Output ONLY one or more blocks, each EXACTLY this shape and nothing between or around them:",
    "<<<HANDSHAKE phase=<phase-id>",
    "## What the prior phase produced",
    "- artifacts + file paths, key results (be specific; cite paths)",
    "## Surprises / blockers to carry forward",
    "- ... (or 'none')",
    "## Suggested adjustments to this phase",
    "- concrete tweaks to THIS phase's roles or mandate, or 'none — proceed as planned'",
    "HANDSHAKE>>>",
    "",
    "Use the exact downstream phase ids given. No prose outside the blocks.",
  ].join("\n");

  const event = [
    `FINISHED PHASE: ${finished.id}`,
    `FINISHED PHASE GOAL: ${finished.goal}`,
    "",
    "FINISHED PHASE LEDGER (its memory — the source of truth for what happened):",
    ledger || "(ledger empty — the phase left no memory; infer from goal only)",
    "",
    "DOWNSTREAM PHASES (earliest first):",
    ...downstream.map(
      (p, idx) =>
        `${idx === 0 ? "[NEXT] " : "       "}${p.id} — goal: ${p.goal}\n         roles: ${p.roles
          .map((r) => `${r.name ?? "(auto)"}: ${r.description}`)
          .join(" | ")}`
    ),
    "",
    `Write a HANDSHAKE for "${next.id}" (required) plus any later phase the outcome materially changes.`,
  ].join("\n");

  let reply: string;
  try {
    const session = new ClaudeSession({
      systemPrompt: sys,
      model: resolveHandshakeModel(),
      stateless: true,
    });
    reply = await session.send(event);
    const u = session.lastUsage;
    if (u) {
      try {
        await recordUsage(runDir, "handshake", u);
      } catch {
        // cost accounting is best-effort
      }
    }
  } catch (e) {
    console.warn(`[journey] handshake generation failed: ${(e as Error).message}`);
    reply =
      `<<<HANDSHAKE phase=${next.id}\n` +
      `## What the prior phase produced\n- See ledger: ${path.relative(dir, ledgerFile)}\n` +
      `## Surprises / blockers to carry forward\n- none recorded (auto-gen failed)\n` +
      `## Suggested adjustments to this phase\n- none — proceed as planned\n` +
      `HANDSHAKE>>>`;
  }

  const blocks = parseHandshakes(reply);
  const validIds = new Set(downstream.map((p) => p.id));
  let wrote = 0;
  for (const b of blocks) {
    if (!validIds.has(b.phase)) {
      console.warn(`[journey] handshake targets unknown/upstream phase "${b.phase}" — skipping`);
      continue;
    }
    const target = path.join(dir, "phases", b.phase, "INBOX.md");
    await mkdir(path.dirname(target), { recursive: true });
    const stamp = `\n\n---\n_Handshake from ${finished.id} · ${new Date().toISOString()}_\n\n`;
    await appendFile(target, stamp + b.body.trim() + "\n", "utf8");
    wrote++;
    console.log(`[journey] handshake → phases/${b.phase}/INBOX.md`);
  }
  if (wrote === 0) {
    console.warn("[journey] no valid handshake blocks parsed — next phase starts without one.");
  }
}

function parseHandshakes(text: string): HandshakeBlock[] {
  const out: HandshakeBlock[] = [];
  const re = /<<<HANDSHAKE\s+phase=([^\s\r\n]+)\r?\n([\s\S]*?)\r?\nHANDSHAKE>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ phase: m[1].trim(), body: m[2] });
  }
  return out;
}

/** Model for the short handshake turn — its own knob, else the orch model, else CLI default. */
function resolveHandshakeModel(): string | undefined {
  const m = (process.env.MD_AGENT_HANDSHAKE_MODEL ?? process.env.MD_AGENT_ORCH_MODEL)?.trim();
  if (!m) return undefined;
  return m in MODEL_IDS ? MODEL_IDS[m as ModelTier] : m;
}
