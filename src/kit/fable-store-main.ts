// The fable-store action's first look (.github/actions/fable-store), for the
// Kit job's Fable cap readings (ADR-0034): whether the Product's Kit config
// opted in to Fable, read from its checkout as data, and, when it did, which
// of the fabrik-runs store's paths the Kit job checks out (fableStorePaths).
// A repo that didn't opt in, or whose Kit config doesn't read, which the
// routing step then fails on, reads nothing of the store. Writes
// `opted-in=true` or `opted-in=false`, and `paths`, one pattern a line, to
// GITHUB_OUTPUT. It needs no token.
//   node src/kit/fable-store-main.ts <product checkout>
import { appendFile } from "node:fs/promises";
import { readKitConfigFromCheckout } from "./checkout.ts";
import { fableStorePaths } from "./fableCapFacts.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(productDir: string): Promise<void> {
  const read = await readKitConfigFromCheckout(productDir);
  const optedIn = read.ok && read.config.allowFable;
  const paths = optedIn ? fableStorePaths(new Date().toISOString()) : [];
  await appendFile(required("GITHUB_OUTPUT"), `opted-in=${optedIn}\npaths<<FABRIK_PATHS\n${paths.map((path) => `${path}\n`).join("")}FABRIK_PATHS\n`);
  console.log(optedIn ? `The Kit config opts in to Fable, so the Kit job reads the store's Fable cap readings: ${paths.join(", ")}` : "The Kit config doesn't opt in to Fable, so the Kit job reads nothing of the store.");
}

const productDir = process.argv[2];
if (productDir === undefined || productDir === "") {
  console.error("Usage: node src/kit/fable-store-main.ts <product checkout>");
  process.exitCode = 2;
} else {
  main(productDir).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
