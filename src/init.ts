import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LaunchConfig } from "./persist.js";
import { theme as t } from "./theme.js";

export const LAUNCH_FILE = "md-agent.launch.json";

/**
 * `md-agent init`: drop a starter launch config into the current repo so the
 * second run never goes through the wizard. The template encodes the harness
 * the tool is built around — a cheap seat behind a verify command, a claude
 * seat for judgement, worktree isolation so every seat's output is a branch to
 * keep or drop — with the advice inline where each choice is made.
 */
export async function runInit(cwd = process.cwd()): Promise<void> {
  const file = path.join(cwd, LAUNCH_FILE);
  if (existsSync(file)) {
    console.log(`${t.paint("!", "amber", true)} ${LAUNCH_FILE} already exists here — edit it, or delete it to re-init.`);
    return;
  }
  const template: LaunchConfig & { $help: Record<string, string> } = {
    $help: {
      goal: "What the team is trying to achieve. Concrete and checkable beats broad.",
      roles: "One seat per role. provider: claude for judgement/review/anything that can be quietly wrong; agy for enumeration, extraction, repeated known edits behind a verifier (content goes to Google). model: opus|sonnet|haiku, or a concrete id.",
      escalate: "false pins a seat at its tier so a verify failure elsewhere can't promote it — keep the cheap seat cheap.",
      fallback: "Auto-heal: where a seat moves when its provider runs dry (quota, rate limit, not ready at preflight). A ladder of {provider, model}; the seat is reseeded there and the orchestrator is told. Per seat, or run-level as the default.",
      verify: "A shell command that proves the result (tests, build, lint). Exit 0 = pass. Gates completion AND judges each seat's worktree at teardown.",
      isolation: "worktree gives every seat its own branch under runs/<run>/workspaces/<role>; audit with git diff, merge what passes, drop what doesn't.",
      permissionMode: "Headless seats auto-deny tools the host doesn't allow. acceptEdits for file edits; bypassPermissions if the seat must run commands.",
      turnTimeoutSec: "Cap on one seat turn (default 300 agy / 600 claude). A turn is a whole agentic loop that re-reads its conversation on every call; keep asks small.",
      budget: "Ceilings: usd and tokens sum every seat; fiveHourPct / sevenDayPct are your plan windows (claude seats report them live). soft = orchestrator winds down, hard = run HALTs and is resumable after the window resets.",
      run: `md-agent --launch ${LAUNCH_FILE}`,
    },
    name: "my-run",
    goal: "Describe the outcome here.",
    roles: [
      {
        name: "worker",
        description: "Does the mechanical part: enumerate the sites, apply the known change, run the check, report file paths.",
        provider: "agy",
        model: "sonnet",
        escalate: false,
        permissionMode: "acceptEdits",
        fallback: [{ provider: "claude", model: "haiku" }],
      },
      {
        name: "reviewer",
        description: "Reads the worker's diff for correctness and anything that can be quietly wrong; says no when it should.",
        provider: "claude",
        model: "opus",
        permissionMode: "acceptEdits",
      },
    ],
    verify: { cmd: "npm test", maxFailures: 2, timeoutSec: 600 },
    escalation: ["sonnet", "opus"],
    isolation: "worktree",
    budget: { usd: { soft: 5, hard: 10 }, fiveHourPct: { soft: 70, hard: 90 } },
    autoComplete: true,
    maxMinutes: 15,
  };
  await writeFile(file, JSON.stringify(template, null, 2) + "\n", "utf8");
  console.log("");
  console.log(` ${t.paint("✔", "green", true)} wrote ${t.bold(LAUNCH_FILE)}`);
  console.log(` ${t.paint("edit", "amber", true)}   goal, the seats, and verify.cmd — the $help block explains each choice`);
  console.log(` ${t.paint("run", "teal", true)}    md-agent   ${t.paint("(the home screen offers this file as a one-key launch)", "dim")}`);
  console.log(`        md-agent --launch ${LAUNCH_FILE}`);
  console.log("");
}

/** Where the bundled skill file lives in this install. */
export function bundledSkillPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "skills", "md-agent", "SKILL.md");
}

/** Where a skill install lands: user-wide, or this project's .claude/skills. */
export function skillInstallDir(scope: "user" | "project" = "user"): string {
  const base =
    scope === "project"
      ? path.join(process.cwd(), ".claude", "skills")
      : process.env.CLAUDE_SKILLS_DIR?.trim() || path.join(os.homedir(), ".claude", "skills");
  return path.join(base, "md-agent");
}

export function skillInstalled(scope: "user" | "project" = "user"): boolean {
  return existsSync(path.join(skillInstallDir(scope), "SKILL.md"));
}

/** Does this machine look like it has Claude Code? (Its home dir exists.) */
export function claudeCodePresent(): boolean {
  return existsSync(path.join(os.homedir(), ".claude"));
}

/** What the user should know once the skill is in place. */
export function printSkillWhereItApplies(dest: string, scope: "user" | "project"): void {
  const dim = (s: string) => t.paint(s, "dim");
  console.log(` ${t.paint("✔", "green", true)} md-agent skill → ${dest}`);
  console.log("");
  console.log(`   ${t.bold("Where it applies")}`);
  console.log(
    scope === "user"
      ? `   Every Claude Code session on this machine — the CLI, the desktop app, the VS Code and JetBrains extensions — in any project.`
      : `   Claude Code sessions started inside this project (commit .claude/skills/ to share it with the team).`
  );
  console.log(`   Picked up at the start of the next session; nothing to restart.`);
  console.log("");
  console.log(`   ${t.bold("How it's used")}`);
  console.log(`   ${dim("·")} Describe a team-sized task — several parts in parallel, a command that can check the result, work that should`);
  console.log(`     end up as branches to review, or a run that outlives the session — and Claude reaches for md-agent on its own.`);
  console.log(`   ${dim("·")} Or invoke it by name: ${t.paint("/md-agent", "teal", true)} followed by the goal.`);
  console.log(`   ${dim("·")} Claude will write the launch config, run it, read the traces, and merge what passed — asking before anything`);
  console.log(`     that spends money or touches your tree.`);
  console.log("");
  console.log(`   ${dim(`md-agent skill uninstall removes it · md-agent skill show prints it`)}`);
}

/**
 * `md-agent skill install [--project]`: put the bundled Claude Code skill
 * (skills/md-agent/SKILL.md) where Claude Code reads skills, so it knows when
 * to reach for a team, how to write a launch config, and how to read a run.
 * `uninstall` removes it; `show` prints it.
 */
export async function installSkill(action = "install", opts: { scope?: "user" | "project" } = {}): Promise<void> {
  const scope = opts.scope ?? "user";
  const src = bundledSkillPath();
  const destDir = skillInstallDir(scope);
  const dest = path.join(destDir, "SKILL.md");
  if (action === "uninstall") {
    const { rm } = await import("node:fs/promises");
    await rm(destDir, { recursive: true, force: true });
    console.log(` ${t.paint("✔", "green", true)} removed ${destDir}`);
    return;
  }
  if (action === "show") {
    process.stdout.write(await readFile(src, "utf8"));
    return;
  }
  if (action !== "install") {
    console.log(`usage: md-agent skill install [--project] | uninstall [--project] | show`);
    return;
  }
  await mkdir(destDir, { recursive: true });
  await copyFile(src, dest);
  printSkillWhereItApplies(dest, scope);
}
