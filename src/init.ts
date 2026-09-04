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
      verify: "A shell command that proves the result (tests, build, lint). Exit 0 = pass. Gates completion AND judges each seat's worktree at teardown.",
      isolation: "worktree gives every seat its own branch under runs/<run>/workspaces/<role>; audit with git diff, merge what passes, drop what doesn't.",
      permissionMode: "Headless seats auto-deny tools the host doesn't allow. acceptEdits for file edits; bypassPermissions if the seat must run commands.",
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

/**
 * `md-agent skill install`: put the bundled Claude Code skill (skills/md-agent/
 * SKILL.md) into ~/.claude/skills/md-agent/, so Claude knows when to reach for
 * a team, how to write a launch config, and how to read a run. `uninstall`
 * removes it; anything else prints the skill.
 */
export async function installSkill(action = "install"): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, "..", "skills", "md-agent", "SKILL.md");
  const destDir = path.join(process.env.CLAUDE_SKILLS_DIR?.trim() || path.join(os.homedir(), ".claude", "skills"), "md-agent");
  const dest = path.join(destDir, "SKILL.md");
  if (action === "uninstall") {
    const { rm } = await import("node:fs/promises");
    await rm(destDir, { recursive: true, force: true });
    console.log(` ${t.paint("✔", "green", true)} removed ${destDir}`);
    return;
  }
  if (action !== "install") {
    process.stdout.write(await readFile(src, "utf8"));
    return;
  }
  await mkdir(destDir, { recursive: true });
  await copyFile(src, dest);
  console.log(` ${t.paint("✔", "green", true)} installed the md-agent skill → ${dest}`);
  console.log(`   ${t.paint("Claude Code picks it up on its next session; /md-agent invokes it by name.", "dim")}`);
}
