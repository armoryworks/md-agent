import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { confirm, input, select } from "@inquirer/prompts";
import { readLedger, readRunCost, readSessionRecords, readState, updateState, type RunState } from "./persist.js";
import { claudeProjectDirFor, findClaudeSessionFile } from "./sessions.js";
import { theme as t } from "./theme.js";

const run = promisify(execFile);

/**
 * Journals: a run's durable record — state, ledger, transcript, context,
 * traces, spend — pushed to a git repository of its own so it survives the
 * machine and can be pulled elsewhere and continued. Never the project repo:
 * `runs/` is gitignored there because transcripts and traces carry
 * credentials and internal findings, which is also why the remote must be
 * private and is checked before every push.
 */

export interface JournalConfig {
  /** Fallback journal repository, used for any project without its own entry in `repos`. */
  remote?: string;
  /** Journal repository per project (`forge` → `git@github.com:armoryworks/forge-md-agent.git`). */
  repos?: Record<string, string>;
  /** Push at every run end without asking. */
  autoPush?: boolean;
  /** false = never ask ("no, and leave me alone"); pushing stays available from the home screen. */
  ask?: boolean;
}

// MD_AGENT_HOME relocates the config + clones (tests, or a shared machine).
const CONFIG_DIR = process.env.MD_AGENT_HOME?.trim() || path.join(os.homedir(), ".config", "md-agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CLONES_DIR = path.join(CONFIG_DIR, "journals");

/** Files that are the journal. Everything else in a run dir is transient or lives elsewhere. */
const JOURNAL_TOP = new Set(["state.json", "ledger.md", "transcript.md", "context.md", "HALT.txt", "JOURNAL.md", "log", "spill", "teams", "sessions", "inbox", "outbox"]);
const INDEX_JSON = "index.json";
const INDEX_MD = "JOURNALS.md";
// Per-participant spend and windows, the seat's current session id, its
// session lineage, and (under sessions/claude/) the claude CLI's own session
// transcripts — what lets a pulled run's seats reattach on another machine.
const SESSION_KEEP = /\.(cost|window)\.json$|\.txt$|\.sessions\.jsonl$|^claude(\/|$)/;

export interface GlobalConfig {
  journal?: JournalConfig;
  /** The one-time Claude Code skill offer on the home screen. */
  skill?: { offeredAt?: string; declined?: boolean };
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function writeGlobalConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig> {
  const cur = await readGlobalConfig();
  const next = { ...cur, ...patch };
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export async function writeGlobalJournalConfig(patch: Partial<JournalConfig>): Promise<JournalConfig> {
  const cur = await readGlobalConfig();
  const next = { ...(cur.journal ?? {}), ...patch };
  await writeGlobalConfig({ journal: next });
  return next;
}

/**
 * Effective journal config for one project: the run's own settings, over the
 * project's repo entry, over the global fallback. `remote` comes back resolved
 * for this project.
 */
export async function resolveJournalConfig(project: string, runOverride?: JournalConfig): Promise<JournalConfig> {
  const g = (await readGlobalConfig()).journal ?? {};
  const merged = { ...g, ...(runOverride ?? {}) };
  return { ...merged, remote: runOverride?.remote ?? g.repos?.[project] ?? g.remote };
}

/** Remember which repo a project's journals go to. */
export async function setProjectRemote(project: string, remote: string): Promise<void> {
  const cur = (await readGlobalConfig()).journal ?? {};
  await writeGlobalJournalConfig({ repos: { ...(cur.repos ?? {}), [project]: remote } });
}

// ---------- the project, the remote, and whether it is private ----------

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Name the journals are filed under: the project repo's directory name. */
export async function projectName(cwd = process.cwd()): Promise<string> {
  try {
    return path.basename(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return path.basename(cwd);
  }
}

/** `owner/name` from a GitHub remote in any of its spellings, else null. */
export function githubSlug(remote: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export type Visibility = "private" | "public" | "internal" | "unknown";

/** Ask GitHub (via gh) whether the repo is private. Anything not GitHub, or unreachable, is "unknown". */
export async function remoteVisibility(remote: string): Promise<Visibility> {
  const slug = githubSlug(remote);
  if (!slug) return "unknown";
  try {
    const { stdout } = await run("gh", ["repo", "view", slug, "--json", "visibility", "-q", ".visibility"]);
    const v = stdout.trim().toLowerCase();
    return v === "private" || v === "public" || v === "internal" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

/** The repo to suggest for a project: `<owner>/<project>-md-agent`, owner from the project's GitHub remote or the gh login. */
export async function suggestedRemote(project: string, cwd = process.cwd()): Promise<{ slug: string; url: string } | null> {
  let owner: string | null = null;
  try {
    const origin = await git(cwd, ["remote", "get-url", "origin"]);
    owner = githubSlug(origin)?.split("/")[0] ?? null;
  } catch {
    // no origin
  }
  if (!owner) {
    try {
      owner = (await run("gh", ["api", "user", "-q", ".login"])).stdout.trim() || null;
    } catch {
      return null;
    }
  }
  const slug = `${owner}/${project}-md-agent`;
  return { slug, url: `git@github.com:${slug}.git` };
}

/** Create the suggested repo, private, and return its clone URL. */
export async function createPrivateRepo(slug: string): Promise<string> {
  await run("gh", ["repo", "create", slug, "--private", "--description", "md-agent journals — run records, transcripts and traces. Keep private.", "--disable-wiki"]);
  return `git@github.com:${slug}.git`;
}

// ---------- the local clone ----------

function cloneDir(remote: string): string {
  const slug = githubSlug(remote) ?? remote.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return path.join(CLONES_DIR, slug.replace("/", "__"));
}

/** Clone on first use, fast-forward after; resolve the clone's path. */
async function ensureClone(remote: string): Promise<string> {
  const dir = cloneDir(remote);
  if (existsSync(path.join(dir, ".git"))) {
    try {
      await git(dir, ["pull", "--ff-only", "--quiet"]);
    } catch {
      // offline or diverged — work with what is there; push will say
    }
    return dir;
  }
  await mkdir(path.dirname(dir), { recursive: true });
  try {
    await run("git", ["clone", "--quiet", remote, dir]);
  } catch (e) {
    const msg = (e as Error).message;
    // A brand-new empty repo clones with a warning; anything else is real.
    if (!existsSync(path.join(dir, ".git"))) throw new Error(`could not clone ${remote}: ${msg.split("\n").slice(-3).join(" ")}`);
  }
  return dir;
}

// ---------- what goes in ----------

const SECRET_PATTERNS: [string, RegExp][] = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abp]-[0-9A-Za-z-]{10,}\b/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._-]{30,}/],
];

/** Look for credential shapes in the journal's text files; returns "<file>: <kind>" hits. */
export async function scanForSecrets(dir: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) {
        if (name.name === ".git") continue;
        await walk(p);
        continue;
      }
      if (!/\.(md|json|jsonl|txt)$/.test(name.name)) continue;
      let text: string;
      try {
        text = await readFile(p, "utf8");
      } catch {
        continue;
      }
      for (const [kind, re] of SECRET_PATTERNS) {
        if (re.test(text)) hits.push(`${path.relative(dir, p)}: ${kind}`);
      }
    }
  };
  await walk(dir);
  return hits;
}

export type RunStatus = "running" | "complete" | "halted" | "unfinished";

async function runStatus(runDir: string, state: RunState): Promise<RunStatus> {
  if (existsSync(path.join(runDir, "HALT.txt"))) return "halted";
  if (state.endedAt) return "complete";
  return "unfinished";
}

/** The human cover page filed with every journal. */
export async function writeCoverPage(runDir: string): Promise<string> {
  const state = await readState(runDir);
  const status = await runStatus(runDir, state);
  const cost = await readRunCost(runDir);
  const ledger = await readLedger(runDir);
  const artifacts = /## Artifacts produced\s*\n([\s\S]*?)(?:\n## |$)/.exec(ledger)?.[1]?.trim() ?? "";
  const traces = existsSync(path.join(runDir, "log")) ? await readdir(path.join(runDir, "log")) : [];
  const lines = [
    `# ${path.basename(runDir)}`,
    "",
    `**Status:** ${status}${state.endReason ? ` — ${state.endReason}` : ""}`,
    `**Spend:** $${cost.costUsd.toFixed(2)} · ${Math.round((cost.inputTokens + cost.cacheReadTokens + cost.cacheCreationTokens + cost.outputTokens) / 1000)}k tokens · ${cost.turns} turns`,
    state.journey ? `**Journey:** ${state.journey.name} · phase ${state.journey.phaseIndex + 1}/${state.journey.total} (${state.journey.phaseId})` : "",
    state.isolation === "worktree" ? "**Isolation:** worktree — each seat's edits are a branch in the project repo (`md-agent/<run>/<seat>`), not in this journal." : "",
    "",
    "## Goal",
    "",
    state.goal,
    "",
    "## Seats",
    "",
    ...state.roles.map((r) => `- **${r.name}** (${r.provider ?? "claude"} · ${r.model ?? "sonnet"})${r.stopped ? ` — stopped${r.stopped.handoffTo ? `, handed to ${r.stopped.handoffTo}` : ""}` : ""}: ${r.description}`),
    "",
    "## Artifacts produced",
    "",
    artifacts || "_(none recorded in the ledger)_",
    "",
    "## In this journal",
    "",
    "- `state.json` — goal, seats, context, budget, journey reference, end stamp",
    "- `ledger.md` — the orchestrator's final memory",
    "- `transcript.md` — every message, checkpoints, verify results",
    ...(traces.length ? [`- \`log/\` — seat traces: ${traces.map((f) => f.replace(/\.jsonl$/, "")).join(", ")}`] : []),
    "- `sessions/*.cost.json` — spend per participant; `sessions/<seat>.sessions.jsonl` — each seat's session lineage; `sessions/claude/` — the claude CLI's own transcripts, restored on pull so seats reattach",
    "",
    "_Journals hold transcripts and traces. Keep this repository private._",
    "",
  ];
  const text = lines.filter((l) => l !== null).join("\n").replace(/\n{3,}/g, "\n\n");
  await writeFile(path.join(runDir, "JOURNAL.md"), text, "utf8");
  return text;
}

/** Copy the journal part of a run dir into the clone under `<project>/<run>/`. */
async function fileRun(runDir: string, clone: string, project: string): Promise<string> {
  const dest = path.join(clone, project, path.basename(runDir));
  await mkdir(dest, { recursive: true });
  await cp(runDir, dest, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(runDir, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (!JOURNAL_TOP.has(top)) return false;
      if (top === "sessions" && rel !== "sessions") return SESSION_KEEP.test(path.relative(path.join(runDir, "sessions"), src));
      return true;
    },
  });
  // The filed state.json must not carry push/pull stamps, or every push would
  // differ from the last and commit again with nothing new.
  const state = JSON.parse(await readFile(path.join(dest, "state.json"), "utf8")) as RunState;
  delete state.journalPush;
  delete state.journalPulledAt;
  await writeFile(path.join(dest, "state.json"), JSON.stringify(state, null, 2), "utf8");
  await fileClaudeSessions(runDir, dest, state);
  return dest;
}

/**
 * The claude CLI keeps a seat's conversation under ~/.claude/projects, not in
 * the run dir. Copy each seat's session transcripts into the journal so a run
 * pulled elsewhere can put them back where that machine's CLI will look.
 */
async function fileClaudeSessions(runDir: string, dest: string, state: RunState): Promise<void> {
  for (const r of state.roles) {
    for (const rec of await readSessionRecords(runDir, r.name)) {
      if (rec.provider !== "claude") continue;
      const src = await findClaudeSessionFile(rec.id);
      if (!src) continue;
      const out = path.join(dest, "sessions", "claude", `${rec.id}.jsonl`);
      await mkdir(path.dirname(out), { recursive: true });
      await cp(src, out, { force: true });
    }
  }
}

/** Put journaled claude sessions where this machine's CLI files the seat's workspace, so `--resume` finds them. */
async function restoreClaudeSessions(runDir: string): Promise<number> {
  const state = await readState(runDir);
  let n = 0;
  for (const r of state.roles) {
    const cwd = r.cwd ?? (state.isolation === "worktree" ? path.join(runDir, "workspaces", r.name) : process.cwd());
    const projDir = claudeProjectDirFor(cwd);
    for (const rec of await readSessionRecords(runDir, r.name)) {
      if (rec.provider !== "claude") continue;
      const src = path.join(runDir, "sessions", "claude", `${rec.id}.jsonl`);
      if (!existsSync(src)) continue;
      const target = path.join(projDir, `${rec.id}.jsonl`);
      if (existsSync(target) || (await findClaudeSessionFile(rec.id))) continue;
      await mkdir(projDir, { recursive: true });
      await cp(src, target);
      n++;
    }
  }
  return n;
}

export interface PushResult {
  ok: boolean;
  detail: string;
}

/** One row of the repo's master index. */
export interface JournalIndexEntry {
  project: string;
  run: string;
  status: RunStatus;
  goal: string;
  costUsd: number;
  turns: number;
  updatedAt: string;
  journey?: { name: string; phaseId: string; phaseIndex: number; total: number };
  endReason?: string;
}

/**
 * Rebuild the master index at the clone's root from every journal in it:
 * index.json for md-agent, JOURNALS.md for people. Read after a single pull,
 * it tells the home screen what the repo holds without opening each run.
 */
export async function writeIndex(clone: string): Promise<JournalIndexEntry[]> {
  const rows: JournalIndexEntry[] = [];
  for (const project of await readdir(clone, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name.startsWith(".")) continue;
    for (const runName of await readdir(path.join(clone, project.name))) {
      const dir = path.join(clone, project.name, runName);
      try {
        const state = await readState(dir);
        const cost = await readRunCost(dir);
        let updatedAt = state.endedAt ?? "";
        try {
          updatedAt = (await stat(path.join(dir, "transcript.md"))).mtime.toISOString();
        } catch {
          // no transcript
        }
        rows.push({
          project: project.name,
          run: runName,
          status: await runStatus(dir, state),
          goal: state.goal ?? "",
          costUsd: cost.costUsd,
          turns: cost.turns,
          updatedAt,
          journey: state.journey ? { name: state.journey.name, phaseId: state.journey.phaseId, phaseIndex: state.journey.phaseIndex, total: state.journey.total } : undefined,
          endReason: state.endReason,
        });
      } catch {
        // not a journal
      }
    }
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  await writeFile(path.join(clone, INDEX_JSON), JSON.stringify({ generatedAt: new Date().toISOString(), journals: rows }, null, 2) + "\n", "utf8");
  const byProject = new Map<string, JournalIndexEntry[]>();
  for (const r of rows) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
  const md: string[] = ["# md-agent journals", "", `_${rows.length} run(s) across ${byProject.size} project(s). Regenerated on every push; \`index.json\` is the machine-readable twin._`, ""];
  for (const [project, list] of byProject) {
    md.push(`## ${project}`, "", "| run | status | spend | goal |", "|---|---|---|---|");
    for (const r of list) {
      const goal = r.goal.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 90);
      md.push(`| [${r.run}](./${encodeURIComponent(project)}/${encodeURIComponent(r.run)}/JOURNAL.md) | ${r.status}${r.journey ? ` · ${r.journey.name} ${r.journey.phaseIndex + 1}/${r.journey.total}` : ""} | $${r.costUsd.toFixed(2)} · ${r.turns}t | ${goal} |`);
    }
    md.push("");
  }
  md.push("_Journals hold transcripts and traces. Keep this repository private._", "");
  await writeFile(path.join(clone, INDEX_MD), md.join("\n"), "utf8");
  return rows;
}

/** The repo's master index after a pull — what it holds, without opening each run. */
export async function readIndex(cfg: JournalConfig): Promise<JournalIndexEntry[]> {
  if (!cfg.remote) return [];
  const clone = await ensureClone(cfg.remote);
  try {
    const parsed = JSON.parse(await readFile(path.join(clone, INDEX_JSON), "utf8"));
    if (Array.isArray(parsed.journals)) return parsed.journals as JournalIndexEntry[];
  } catch {
    // no index yet (older repo) — build one locally without pushing
  }
  return writeIndex(clone);
}

/**
 * Push one run's journal. Refuses a public remote, warns on an unverifiable
 * one, and stops on credential shapes unless `force`. Interactive checks go
 * through `ask`; pass none for a silent (auto) push that refuses on any doubt.
 */
export async function pushJournal(
  runDir: string,
  cfg: JournalConfig,
  project: string,
  ask?: { confirm: (message: string) => Promise<boolean> }
): Promise<PushResult> {
  if (!cfg.remote) return { ok: false, detail: `no journal repo configured for ${project}` };
  const vis = await remoteVisibility(cfg.remote);
  if (vis === "public") {
    return { ok: false, detail: `${cfg.remote} is PUBLIC — journals hold transcripts and traces; use a private repository` };
  }
  if (vis !== "private") {
    const msg = vis === "internal"
      ? `${cfg.remote} is INTERNAL (visible to the whole organization). Push anyway?`
      : `Could not verify that ${cfg.remote} is private (not GitHub, or gh can't see it). Push anyway?`;
    if (!ask || !(await ask.confirm(msg))) return { ok: false, detail: `visibility ${vis} — not pushed` };
  }
  await writeCoverPage(runDir);
  const hits = await scanForSecrets(runDir);
  if (hits.length) {
    const msg = `Credential-shaped strings found in the journal:\n  ${hits.slice(0, 8).join("\n  ")}${hits.length > 8 ? `\n  … ${hits.length - 8} more` : ""}\nPush anyway?`;
    if (!ask || !(await ask.confirm(msg))) return { ok: false, detail: `${hits.length} credential-shaped string(s) — not pushed` };
  }
  const clone = await ensureClone(cfg.remote);
  await fileRun(runDir, clone, project);
  await writeIndex(clone);
  const state = await readState(runDir);
  const status = await runStatus(runDir, state);
  await git(clone, ["add", "-A"]);
  const staged = await git(clone, ["status", "--porcelain"]);
  if (!staged) {
    await updateState(runDir, { journalPush: { at: new Date().toISOString(), remote: cfg.remote } });
    return { ok: true, detail: "already up to date" };
  }
  await git(clone, ["-c", "user.name=md-agent", "-c", "user.email=md-agent@armoryworks.com", "commit", "-q", "-m", `journal: ${project}/${path.basename(runDir)} — ${status}`]);
  try {
    await git(clone, ["push", "--quiet", "-u", "origin", "HEAD"]);
  } catch (e) {
    return { ok: false, detail: `committed locally in ${clone} but push failed: ${(e as Error).message.split("\n").slice(-2).join(" ")}` };
  }
  await updateState(runDir, { journalPush: { at: new Date().toISOString(), remote: cfg.remote } });
  return { ok: true, detail: `${project}/${path.basename(runDir)} → ${cfg.remote}` };
}

/** Journals in the remote, by project — from the master index. */
export async function listRemoteJournals(cfg: JournalConfig): Promise<{ project: string; run: string; dir: string; goal: string; status: string }[]> {
  if (!cfg.remote) return [];
  const clone = await ensureClone(cfg.remote);
  const rows = await readIndex(cfg);
  return rows.map((r) => ({ project: r.project, run: r.run, dir: path.join(clone, r.project, r.run), goal: r.goal, status: r.status }));
}

/** Copy a journal from the clone into ./runs so it appears on the home screen. */
export async function pullJournal(journalDir: string, runsDir = path.resolve("runs")): Promise<string> {
  const dest = path.join(runsDir, path.basename(journalDir));
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  await cp(journalDir, dest, { recursive: true });
  // Mailboxes travel for completeness but must start empty: a stale dispatch
  // or reply would be replayed the moment the seats spawn.
  for (const box of ["inbox", "outbox"]) {
    const d = path.join(dest, box);
    await mkdir(d, { recursive: true });
    for (const f of await readdir(d)) await writeFile(path.join(d, f), "", "utf8");
  }
  try {
    const n = await restoreClaudeSessions(dest);
    if (n) console.log(` ${t.paint("▸", "amber", true)} ${n} claude session(s) restored — seats will reattach on Continue`);
  } catch (e) {
    console.warn(`[journal] could not restore seat sessions: ${(e as Error).message}`);
  }
  await updateState(dest, { journalPulledAt: new Date().toISOString() });
  return dest;
}

// ---------- the ask at run end ----------

export type EndOffer = "pushed" | "skipped" | "never" | "failed";

const NEVER = "never";
const NOT_NOW = "not-now";
export const NEVER_CHOICE = { name: "No, and don't ask again — ever", value: NEVER, description: "remembered globally; pushing stays available from the home screen" };

export async function rememberNever(): Promise<void> {
  await writeGlobalJournalConfig({ ask: false });
  console.log(` ${t.paint("▸", "amber", true)} understood — journals won't be offered again (home screen → Journals, if you change your mind)`);
}

/**
 * Choose (or create) the journal repo for a project. Suggests a private
 * `<owner>/<project>-md-agent`; offers the shared fallback repo when one is
 * set; takes a URL. Returns the remote, or null for "not now" / "never".
 * Every step carries the permanent opt-out.
 */
export async function chooseProjectRemote(project: string, cfg: JournalConfig): Promise<string | null | "never"> {
  const sug = await suggestedRemote(project);
  const choice = await select<string>({
    message: `Where should ${project}'s journals live?`,
    choices: [
      ...(sug ? [{ name: `Create private repo ${sug.slug} and use it`, value: "create", description: "gh repo create --private; remembered for this project" }] : []),
      ...(cfg.remote ? [{ name: `Use the shared journal repo ${cfg.remote}`, value: "shared", description: `filed under ${project}/ inside it` }] : []),
      { name: "Enter the git URL of a private repo", value: "url" },
      { name: "Not now", value: NOT_NOW },
      NEVER_CHOICE,
    ],
  });
  if (choice === NEVER) {
    await rememberNever();
    return "never";
  }
  if (choice === NOT_NOW) return null;
  let remote: string;
  if (choice === "create" && sug) {
    remote = await createPrivateRepo(sug.slug);
    console.log(` ${t.paint("✔", "green", true)} created ${sug.slug} (private)`);
  } else if (choice === "shared" && cfg.remote) {
    remote = cfg.remote;
  } else {
    remote = (await input({ message: "Journal repo git URL:" })).trim();
    if (!remote) return null;
    const vis = await remoteVisibility(remote);
    if (vis === "public") {
      console.log(` ${t.paint("✖", "red", true)} ${remote} is PUBLIC. Journals hold transcripts and traces — make it private first, or create a new private one.`);
      return null;
    }
    if (vis !== "private") {
      const ok = await confirm({ message: `Could not verify that ${remote} is private. Use it anyway?`, default: false });
      if (!ok) return null;
    }
  }
  await setProjectRemote(project, remote);
  return remote;
}

/**
 * At a run's end — clean, interrupted, or halted — offer to push its journal.
 * A project with no repo yet is walked through choosing one. "No, and don't
 * ask again" is remembered globally; the home screen still pushes on request.
 */
export async function offerPushAtEnd(runDir: string, runOverride?: JournalConfig): Promise<EndOffer> {
  const project = await projectName();
  const cfg = await resolveJournalConfig(project, runOverride);
  if (cfg.ask === false) return "skipped";
  const say = (s: string) => console.log(` ${t.paint("▸", "amber", true)} ${s}`);
  if (cfg.autoPush && cfg.remote) {
    const r = await pushJournal(runDir, cfg, project);
    say(r.ok ? `journal pushed: ${r.detail}` : `journal NOT pushed — ${r.detail}`);
    return r.ok ? "pushed" : "failed";
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "skipped";

  try {
    if (!cfg.remote) {
      const first = await select<string>({
        message: "Keep this run's journal (state, ledger, transcript, traces) in source control?",
        choices: [
          { name: "Yes — pick or create a private repo for this project", value: "yes" },
          { name: "Not now", value: NOT_NOW },
          NEVER_CHOICE,
        ],
      });
      if (first === NEVER) {
        await rememberNever();
        return "never";
      }
      if (first === NOT_NOW) return "skipped";
      const remote = await chooseProjectRemote(project, cfg);
      if (remote === "never") return "never";
      if (!remote) return "skipped";
      cfg.remote = remote;
    } else {
      const choice = await select<string>({
        message: `Push this run's journal to ${cfg.remote}?`,
        choices: [
          { name: "Yes", value: "yes" },
          { name: "Yes, and always push without asking", value: "always" },
          { name: "Not now", value: NOT_NOW },
          NEVER_CHOICE,
        ],
      });
      if (choice === NEVER) {
        await rememberNever();
        return "never";
      }
      if (choice === NOT_NOW) return "skipped";
      if (choice === "always") await writeGlobalJournalConfig({ autoPush: true });
    }
    const r = await pushJournal(runDir, cfg, project, { confirm: (message) => confirm({ message, default: false }) });
    say(r.ok ? `journal pushed: ${r.detail}` : `journal NOT pushed — ${r.detail}`);
    return r.ok ? "pushed" : "failed";
  } catch (e) {
    if ((e as Error).name === "ExitPromptError") return "skipped";
    say(`journal: ${(e as Error).message}`);
    return "failed";
  }
}
