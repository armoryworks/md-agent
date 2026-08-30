import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Isolation } from "./persist.js";

const run = promisify(execFile);

/** Run git in `cwd`, resolving to trimmed stdout; rejects with stderr on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** Branch a seat's worktree lives on. Namespaced so it is obvious who made it. */
export function workspaceBranch(runName: string, role: string): string {
  return `md-agent/${runName}/${role}`;
}

/**
 * Give one role its own working directory.
 *
 * isolation "none" → returns undefined; the seat shares md-agent's cwd.
 * isolation "worktree" → creates (or reuses, on resume) a git worktree at
 * <runDir>/workspaces/<role> on its own branch, cut from the repo's current HEAD.
 *
 * Never falls back silently: if the target is not a git repo, this throws. A
 * quiet fall back to the shared tree would defeat the point — you would think
 * edits were contained while they were not.
 */
export async function provisionWorkspace(opts: {
  isolation: Isolation;
  repoDir: string;
  runDir: string;
  runName: string;
  role: string;
}): Promise<string | undefined> {
  if (opts.isolation !== "worktree") return undefined;

  if (!(await isGitRepo(opts.repoDir))) {
    throw new Error(
      `isolation "worktree" needs a git repo, but ${opts.repoDir} is not one.\n` +
        `Run md-agent from inside the target repo, or set isolation to "none".`
    );
  }

  const dir = path.join(opts.runDir, "workspaces", opts.role);
  if (existsSync(path.join(dir, ".git"))) return dir; // resume: reuse it

  await mkdir(path.dirname(dir), { recursive: true });
  const branch = workspaceBranch(opts.runName, opts.role);
  const head = await git(opts.repoDir, ["rev-parse", "HEAD"]);

  try {
    await git(opts.repoDir, ["worktree", "add", "-b", branch, dir, head]);
  } catch (e) {
    // A leftover branch from a prior run of the same name: attach to it rather
    // than failing the spawn.
    const msg = (e as Error).message;
    if (/already exists/i.test(msg)) {
      await git(opts.repoDir, ["worktree", "add", dir, branch]);
    } else {
      throw e;
    }
  }
  return dir;
}

/** One role's workspace and what it changed, for the end-of-run audit. */
export interface WorkspaceReport {
  role: string;
  dir: string;
  branch: string;
  /** Commits ahead of the base HEAD the worktree was cut from. */
  commits: number;
  /** `git diff --stat` against that base, including uncommitted work. */
  diffstat: string;
  changedFiles: number;
}

/**
 * Summarize what each seat actually did. This is the audit surface: the point of
 * isolation is that a run's output can be read as a diff and then kept or
 * dropped, rather than being already mixed into your tree.
 */
export async function reportWorkspaces(opts: {
  repoDir: string;
  runDir: string;
  runName: string;
  roles: string[];
}): Promise<WorkspaceReport[]> {
  const out: WorkspaceReport[] = [];
  for (const role of opts.roles) {
    const dir = path.join(opts.runDir, "workspaces", role);
    if (!existsSync(path.join(dir, ".git"))) continue;
    const branch = workspaceBranch(opts.runName, role);
    let commits = 0;
    let diffstat = "";
    let changedFiles = 0;
    try {
      const base = await git(dir, ["merge-base", "HEAD", "HEAD@{1}"]).catch(() => "");
      const against = base || (await git(opts.repoDir, ["rev-parse", "HEAD"]));
      commits = Number(await git(dir, ["rev-list", "--count", `${against}..HEAD`])) || 0;
      diffstat = await git(dir, ["diff", "--stat", against]);
      const names = await git(dir, ["diff", "--name-only", against]);
      changedFiles = names ? names.split("\n").filter(Boolean).length : 0;
    } catch {
      // A workspace we cannot read is still worth listing; leave the counts at 0.
    }
    out.push({ role, dir, branch, commits, diffstat, changedFiles });
  }
  return out;
}
