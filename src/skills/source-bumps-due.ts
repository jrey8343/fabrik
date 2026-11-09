// The weekly gate on a Product repo's skills bumps, for the Kit's scheduled
// tick: writes `due=true` to the step's outputs on the tick the bump acts on
// (the Monday tick in the 04:00 UTC hour, src/skills/bump.ts), else `due=false`,
// and says which in the step summary, with when the next bump tick is.
//   GITHUB_OUTPUT=<file> FABRIK_TICK_SCHEDULE=<cron> FABRIK_TICK_SEEN_AT=<ISO time> \
//     node src/skills/source-bumps-due.ts
// FABRIK_TICK_SCHEDULE is the caller's cron (github.event.schedule), and
// FABRIK_TICK_SEEN_AT when the run's first job started. The gate checks the
// scheduled tick those give, not the step's own clock, so a run GitHub starts
// late still counts as the tick it was scheduled for. A run more than an hour
// late is taken for the next tick; a dropped tick waits a week, and the next
// tick's summary line says the week's bump was missed if no run took it as due.
import { appendFile } from "node:fs/promises";
import { skillsBumpGate } from "./bump.ts";

const output = process.env["GITHUB_OUTPUT"];
if (output === undefined || output === "") {
  console.error("GITHUB_OUTPUT is not set");
  process.exitCode = 2;
} else {
  const seenAt = new Date(process.env["FABRIK_TICK_SEEN_AT"] || Date.now());
  const { due, summary } = skillsBumpGate(Number.isNaN(seenAt.getTime()) ? new Date() : seenAt, process.env["FABRIK_TICK_SCHEDULE"]);
  console.log(summary);
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary !== undefined && stepSummary !== "") await appendFile(stepSummary, `${summary}\n`);
  await appendFile(output, `due=${due}\n`);
}
