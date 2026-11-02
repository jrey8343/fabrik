// Writes the Implement job's OP_ENV_FILE: one `NAME=op://…` line per test
// secret the Product's Kit config declares, read from the checkout as data.
//   node src/kit/secrets-main.ts <product checkout> <output file>
import { writeFile } from "node:fs/promises";
import { readKitConfigFromCheckout } from "./checkout.ts";
import { secretsTemplate } from "./secrets.ts";

async function main(productDir: string, outFile: string): Promise<void> {
  const resolved = await readKitConfigFromCheckout(productDir);
  if (!resolved.ok) {
    for (const error of resolved.errors) console.log(`::error title=Invalid Kit config::${error}`);
    process.exitCode = 1;
    return;
  }
  const template = secretsTemplate(resolved.config);
  await writeFile(outFile, template, { mode: 0o600 });
  console.log(`Test secrets to load: ${Object.keys(resolved.config.sandbox.secrets).join(", ") || "none"}`);
}

const [productDir, outFile] = process.argv.slice(2);
if (productDir === undefined || outFile === undefined) {
  console.error("Usage: node src/kit/secrets-main.ts <product checkout> <output file>");
  process.exitCode = 2;
} else {
  main(productDir, outFile).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
