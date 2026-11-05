// The write the Run record action's first look at the store
// (.github/actions/write-run-record): asks, as the Fabrik App itself, whether
// it's installed on fabrik-runs, and writes `installed=true` or `installed=false`
// to GITHUB_OUTPUT. The store's token is minted only when it is, so a store
// setup hasn't made yet fails no step and leaves no error annotation.
//   node src/kit/find-store-main.ts
// Reads the App's FABRIK_APP_CLIENT_ID and FABRIK_APP_PRIVATE_KEY.
import { appendFile } from "node:fs/promises";
import { appJwt } from "../github/appJwt.ts";
import { GitHub } from "../github/client.ts";
import { RUN_STORE_REPO, storeInstalled } from "./runStore.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const jwt = appJwt(required("FABRIK_APP_CLIENT_ID"), required("FABRIK_APP_PRIVATE_KEY"), Date.now());
  const installed = await storeInstalled(new GitHub(jwt, process.env["GITHUB_API_URL"]));
  await appendFile(required("GITHUB_OUTPUT"), `installed=${installed}\n`);
  console.log(installed ? `The Fabrik App is installed on ${RUN_STORE_REPO}.` : `The Fabrik App isn't installed on ${RUN_STORE_REPO} yet.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
