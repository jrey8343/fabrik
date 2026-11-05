// The weekly gate on a Product repo's skills bumps, for the Kit's scheduled
// tick: writes `due=true` to the step's outputs on the tick the bump acts on
// (the Monday tick in the 04:00 UTC hour, src/skills/bump.ts), else `due=false`.
//   GITHUB_OUTPUT=<file> node src/skills/source-bumps-due.ts
import { appendFile } from "node:fs/promises";
import { isSkillsBumpTick } from "./bump.ts";

const output = process.env["GITHUB_OUTPUT"];
if (output === undefined || output === "") {
  console.error("GITHUB_OUTPUT is not set");
  process.exitCode = 2;
} else {
  const due = isSkillsBumpTick(new Date());
  console.log(due ? "This is the weekly skills bump tick." : "Not the weekly skills bump tick; nothing to bump.");
  await appendFile(output, `due=${due}\n`);
}
