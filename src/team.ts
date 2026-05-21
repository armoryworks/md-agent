/**
 * Sub-teams (v1: 1:1 huddle).
 *
 * The orchestrator can send two roles off to work a sub-problem together. They
 * talk to each other in a bounded back-and-forth and only one consolidated
 * result returns to the orchestrator — the orchestrator never sees the chatter,
 * so a huddle moves a cluster of iteration OFF its (ledger-bounded) context
 * instead of thrashing through it one slow turn at a time.
 *
 * v1 supports exactly two members (the 1:1 case). The engine is written so that
 * N-way modes (lead-directed / peer round-robin) layer on later as different
 * "who speaks next" policies over the same plumbing.
 */

/** Default round cap; override per-team with `maxRounds=` or globally via env. */
const DEFAULT_MAX_ROUNDS = (() => {
  const v = process.env.MD_AGENT_TEAM_MAX_ROUNDS;
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 12;
})();

/** Keep huddle prompts bounded — only the tail of the conversation is shown. */
const CHANNEL_TAIL_CHARS = 10_000;

export interface TeamSpec {
  name: string;
  /** Exactly two role names in v1. */
  members: string[];
  /** Who summarizes if the round cap is hit. Defaults to members[0]. */
  reporter: string;
  maxRounds: number;
  brief: string;
}

/** I/O the engine needs, supplied by the orchestrator (keeps this module pure). */
export interface TeamIO {
  /** Send a message to a member and await its reply (via inbox/outbox). */
  ask(role: string, message: string): Promise<string>;
  /** Record a line to the team's durable channel log (human/audit record). */
  appendChannel(team: string, who: string, msg: string): Promise<void>;
  /** True once the run is shutting down — the engine bails out promptly. */
  isStopping(): boolean;
}

export interface TeamResult {
  status: "done" | "blocked" | "capped" | "aborted";
  report: string;
}

/**
 * Parse `TEAM:` blocks out of an orchestrator reply. Format:
 *   TEAM: <name> members=<a>,<b> [reporter=<a>] [maxRounds=N]
 *   <shared task brief...>
 * Blocks are separated from TO: blocks by a line containing only `---`.
 * v1 requires exactly two members; malformed blocks are skipped (reported).
 */
export function parseTeamBlocks(text: string): { specs: TeamSpec[]; errors: string[] } {
  const specs: TeamSpec[] = [];
  const errors: string[] = [];
  for (const chunk of text.split(/\r?\n---\r?\n/)) {
    const m = /^[ \t]*TEAM:[ \t]*(\S+)[ \t]*(.*)\r?\n([\s\S]*)$/m.exec(chunk);
    if (!m) continue;
    const name = m[1].trim();
    const header = m[2] ?? "";
    const brief = (m[3] ?? "").trim();

    const members = (/members=([^\s]+)/i.exec(header)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (members.length !== 2) {
      errors.push(`team "${name}": v1 needs exactly 2 members (got ${members.length})`);
      continue;
    }
    const reporterRaw = /reporter=([^\s]+)/i.exec(header)?.[1]?.trim();
    const reporter = reporterRaw && members.includes(reporterRaw) ? reporterRaw : members[0];
    const roundsRaw = Number(/maxRounds=(\d+)/i.exec(header)?.[1]);
    const maxRounds = Number.isFinite(roundsRaw) && roundsRaw >= 1 ? roundsRaw : DEFAULT_MAX_ROUNDS;

    specs.push({ name, members, reporter, maxRounds, brief });
  }
  return { specs, errors };
}

function tail(lines: string[]): string {
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 2;
    if (total > CHANNEL_TAIL_CHARS && kept.length > 0) break;
    kept.unshift(lines[i]);
  }
  return kept.join("\n\n");
}

function matchDone(reply: string): string | null {
  const m = /TEAM-DONE:\s*([\s\S]+)/i.exec(reply);
  return m ? m[1].trim() : null;
}

function matchBlocked(reply: string): string | null {
  const m = /TEAM-BLOCKED:\s*([\s\S]+)/i.exec(reply);
  return m ? m[1].trim() : null;
}

function huddlePrompt(spec: TeamSpec, speaker: string, partner: string, channel: string[]): string {
  return [
    `You are "${speaker}" in a two-person huddle "${spec.name}" with "${partner}".`,
    "Shared task:",
    spec.brief,
    "",
    "Huddle so far:",
    channel.length ? tail(channel) : "(nothing yet — you open the huddle)",
    "",
    "Continue the huddle with your partner. Be concise — detailed work goes in files; reference paths, do not paste large content.",
    "Reply with EXACTLY ONE of:",
    "  • your next message to your partner (a question, answer, or proposal), OR",
    "  • `TEAM-DONE: <2-4 sentence summary of what you jointly concluded + file pointers>` when you are finished, OR",
    "  • `TEAM-BLOCKED: <the specific question or decision you need from the orchestrator>` if you cannot proceed.",
  ].join("\n");
}

function summaryPrompt(spec: TeamSpec, channel: string[]): string {
  return [
    `The huddle "${spec.name}" has reached its round limit. Shared task:`,
    spec.brief,
    "",
    "Huddle so far:",
    tail(channel),
    "",
    "Wrap up now. Reply with `TEAM-DONE: <summary of where things landed, any open items, and file pointers>`.",
  ].join("\n");
}

/**
 * Run a 1:1 huddle: the two members alternate (starting with the reporter) until
 * one declares TEAM-DONE / TEAM-BLOCKED or the round cap is hit, in which case
 * the reporter is asked for a closing summary. Returns the single result to fold
 * back into the orchestrator's ledger.
 */
export async function runHuddle(spec: TeamSpec, io: TeamIO): Promise<TeamResult> {
  const channel: string[] = [];
  // Start with the reporter so the designated owner frames the huddle.
  let speaker = spec.reporter;
  let partner = spec.members.find((m) => m !== speaker) ?? spec.members[0];

  for (let round = 0; round < spec.maxRounds; round++) {
    if (io.isStopping()) return { status: "aborted", report: "(run stopping)" };

    const reply = await io.ask(speaker, huddlePrompt(spec, speaker, partner, channel));
    channel.push(`[${speaker}] ${reply}`);
    await io.appendChannel(spec.name, speaker, reply);

    const done = matchDone(reply);
    if (done) return { status: "done", report: done };
    const blocked = matchBlocked(reply);
    if (blocked) return { status: "blocked", report: blocked };

    [speaker, partner] = [partner, speaker];
  }

  // Cap reached without a verdict — ask the reporter to close it out.
  if (io.isStopping()) return { status: "aborted", report: "(run stopping)" };
  const summary = await io.ask(spec.reporter, summaryPrompt(spec, channel));
  await io.appendChannel(spec.name, spec.reporter, summary);
  return { status: "capped", report: matchDone(summary) ?? summary.trim() };
}
