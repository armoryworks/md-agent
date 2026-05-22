import path from "node:path";
import { parseArgs } from "node:util";
import { resumeOrchestrator, runFromConfig, runOrchestrator } from "./orchestrator.js";
import { runJourney } from "./journey.js";
import { runRole } from "./role.js";

const { values } = parseArgs({
  options: {
    role: { type: "string" },
    run: { type: "string" },
    context: { type: "string" },
    // Resume an existing run: `--resume <run-dir>` (orchestrator side).
    resume: { type: "string" },
    // Internal flag passed to spawned role children when resuming.
    resumed: { type: "boolean" },
    // Override + persist the checkpoint interval (minutes) when resuming.
    minutes: { type: "string" },
    // Launch a single run from a JSON config, no wizard (UI still runs).
    launch: { type: "string" },
    // Run a templated multi-phase journey manifest with inter-phase handshakes.
    journey: { type: "string" },
    // Disable the sticky top-of-console roles panel.
    "no-dashboard": { type: "boolean" },
  },
  allowPositionals: true,
});

if (values["no-dashboard"]) {
  process.env.MD_AGENT_NO_DASHBOARD = "1";
}

if (values.role) {
  if (!values.run) {
    console.error("Error: --role requires --run <run-dir>");
    process.exit(1);
  }
  await runRole(values.role, values.run, { resume: !!values.resumed });
} else if (values.journey) {
  await runJourney(path.resolve(values.journey));
} else if (values.launch) {
  await runFromConfig(path.resolve(values.launch));
} else if (values.resume) {
  let minutes: number | undefined;
  if (values.minutes != null) {
    const n = Number(values.minutes);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`Error: --minutes must be a number >= 1 (got "${values.minutes}")`);
      process.exit(1);
    }
    minutes = n;
  }
  await resumeOrchestrator(path.resolve(values.resume), { minutes });
} else {
  await runOrchestrator({ contextFile: values.context });
}
