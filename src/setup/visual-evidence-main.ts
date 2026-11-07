// The Visual evidence writer's program, which /fabrik-visual-evidence runs
// from a Fabrik checkout at the release the Product repo pins, in the Product
// repo's checkout, with the Operator's confirmed answers on stdin:
//   node <fabrik>/src/setup/visual-evidence-main.ts < answers.json
// The answers are the Kit config's ui and preview blocks, in JSON. It writes
// them into .fabrik/config.json, or names each problem and writes nothing.
// It needs no gh and no op. Thin by design: every decision is in
// visualEvidence.ts.
import { readFile, writeFile } from "node:fs/promises";
import { KIT_CONFIG_PATH } from "../kit/config.ts";
import { writeVisualEvidence } from "./visualEvidence.ts";

async function main(): Promise<number> {
  const config = await readFile(KIT_CONFIG_PATH, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let answers = "";
  for await (const chunk of process.stdin) answers += String(chunk);
  const result = writeVisualEvidence(config, answers);
  if (!result.ok) {
    console.error([`Nothing was written to ${KIT_CONFIG_PATH}:`, ...result.problems.map((problem) => `- ${problem}`)].join("\n"));
    return 1;
  }
  if (result.written.length === 0) {
    console.log(`${KIT_CONFIG_PATH} already holds these answers, so nothing was written.`);
    return 0;
  }
  await writeFile(KIT_CONFIG_PATH, result.config);
  const blocks = result.written.length === 1 ? `the ${result.written[0]} block` : "the ui and preview blocks";
  console.log(`Wrote ${blocks} to ${KIT_CONFIG_PATH}.`);
  return 0;
}

if (import.meta.main) {
  if (process.argv.length > 2 || process.stdin.isTTY === true) {
    console.error(
      "Usage: node src/setup/visual-evidence-main.ts < answers.json, from the Product repo's checkout, where the answers are its Kit config's ui and preview blocks in JSON",
    );
    process.exit(2);
  }
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
