/**
 * Smoke test for the merged-tree gate (src/workspace.ts mergeWorkspaces): two seat
 * branches that touch different files merge and both land; a third that edits the
 * same line as the first conflicts, is aborted and named with its path, and the
 * others still merge. Real git, temp repo, no model calls.
 * Run: npx tsx smoke-workspace.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeWorkspaces, provisionWorkspace, removeMergedWorkspace, workspaceBranch } from "./src/workspace.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

async function main(): Promise<void> {
  const repo = mkdtempSync(path.join(tmpdir(), "md-agent-ws-"));
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  const runDir = path.join(repo, "runs", "r1");
  const runName = "r1";
  const ws = async (role: string) => (await provisionWorkspace({ isolation: "worktree", repoDir: repo, runDir, runName, role }))!;
  const a = await ws("alpha"), b = await ws("beta"), c = await ws("gamma");
  writeFileSync(path.join(a, "a.txt"), "alpha\n"); git(a, "add", "-A"); git(a, "commit", "-qm", "alpha edits a");
  writeFileSync(path.join(b, "b.txt"), "beta\n"); git(b, "add", "-A"); git(b, "commit", "-qm", "beta adds b");
  writeFileSync(path.join(c, "a.txt"), "gamma\n"); git(c, "add", "-A"); git(c, "commit", "-qm", "gamma edits a too");

  console.log("two disjoint branches:");
  let m = await mergeWorkspaces({ repoDir: repo, runDir, runName, roles: ["alpha", "beta"] });
  check("both merged, no conflict", m.merged.length === 2 && m.conflicts.length === 0, JSON.stringify(m));
  check("merged tree holds both changes", readFileSync(path.join(m.dir, "a.txt"), "utf8") === "alpha\n" && existsSync(path.join(m.dir, "b.txt")));
  check("scratch tree is detached from the base, not a seat branch", git(m.dir, "rev-parse", "--abbrev-ref", "HEAD") === "HEAD");
  await removeMergedWorkspace(repo, m.dir);
  check("scratch tree removed", !existsSync(m.dir));

  console.log("a conflicting third branch:");
  m = await mergeWorkspaces({ repoDir: repo, runDir, runName, roles: ["alpha", "beta", "gamma"] });
  check("alpha and beta merged", m.merged.includes(workspaceBranch(runName, "alpha")) && m.merged.includes(workspaceBranch(runName, "beta")));
  check("gamma conflicts and names a.txt", m.conflicts.length === 1 && m.conflicts[0].role === "gamma" && m.conflicts[0].files.includes("a.txt"), JSON.stringify(m.conflicts));
  check("the aborted merge left the scratch tree clean", git(m.dir, "status", "--porcelain") === "");
  check("scratch tree still holds the clean merges", readFileSync(path.join(m.dir, "a.txt"), "utf8") === "alpha\n" && existsSync(path.join(m.dir, "b.txt")));
  await removeMergedWorkspace(repo, m.dir);
  check("re-running is idempotent", (await mergeWorkspaces({ repoDir: repo, runDir, runName, roles: ["alpha"] })).merged.length === 1);

  console.log("agy pricing:");
  {
    const { AgySession } = await import("./src/agy.js");
    const s = new AgySession({ model: "x", pricing: { input: 2, output: 10, cacheRead: 0.5 } });
    const price = (s as unknown as { price: (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number }) => number }).price;
    check("estimated cost from per-million prices", Math.abs(price.call(s, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 }) - 4) < 1e-9);
    const z = new AgySession({ model: "x" });
    check("no pricing → $0", (z as unknown as { price: (u: object) => number }).price.call(z, { inputTokens: 5, outputTokens: 5, cacheReadTokens: 5 }) === 0);
  }

  rmSync(repo, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED ✗` : "\nALL PASS ✓");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
