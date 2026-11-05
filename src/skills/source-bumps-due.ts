// The weekly gate on a Product repo's skills bumps, for the Kit's scheduled
// tick: writes `due=true` to the step's outputs on the tick the bump acts on
// (the Monday tick in the 04:00 UTC hour, src/skills/bump.ts), else `due=false`.
//   GITHUB_OUTPUT=<file> FABRIK_TICK_SCHEDULE=<cron> FABRIK_TICK_SEEN_AT=<ISO time> \
//     node src/skills/source-bumps-due.ts
// FABRIK_TICK_SCHEDULE is the caller's cron (github.event.schedule), and
// FABRIK_TICK_SEEN_AT when the run's first job started. The gate checks the
// scheduled tick those give, not the step's own clock, so a run GitHub starts
// late still counts as the tick it was scheduled for. A run more than an hour
// late is taken for the next tick; a dropped tick waits a week.
import { appendFile } from "node:fs/promises";
import { isSkillsBumpTick, scheduledTickOf } from "./bump.ts";

const output = process.env["GITHUB_OUTPUT"];
if (output === undefined || output === "") {
  console.error("GITHUB_OUTPUT is not set");
  process.exitCode = 2;
} else {
  const seenAt = new Date(process.env["FABRIK_TICK_SEEN_AT"] || Date.now());
  const tick = scheduledTickOf(Number.isNaN(seenAt.getTime()) ? new Date() : seenAt, process.env["FABRIK_TICK_SCHEDULE"]);
  const due = isSkillsBumpTick(tick);
  console.log(
    due
      ? `The tick scheduled for ${tick.toISOString()} is the weekly skills bump tick.`
      : `The tick scheduled for ${tick.toISOString()} is not the weekly skills bump tick; nothing to bump.`,
  );
  await appendFile(output, `due=${due}\n`);
}
