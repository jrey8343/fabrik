// The setup wizard is the half of /fabrik-setup the Operator runs in their own
// terminal, so it's run here as they'd run it: with `gh`, `op` and the browser
// stubbed, and their answers piped in.
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const WIZARD = resolve(import.meta.dirname, "..", "..", "skills", "fabrik-setup", "wizard.sh");

/** An `op` that holds the given "vault/title" items, and logs each call with the template it was given. */
const FAKE_OP = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const template = flag("--template");
appendFileSync(process.env.STUB_DIR + "/op.log", JSON.stringify({
  args, template: template === null ? null : JSON.parse(readFileSync(template, "utf8")),
}) + "\\n");
if (args[0] === "item" && args[1] === "get") {
  const items = JSON.parse(process.env.STUB_OP_ITEMS);
  process.exit(items.includes(flag("--vault") + "/" + args[2]) ? 0 : 1);
}
`;

const FAKE_GH = `#!/bin/sh
case "$*" in
  "repo view --json nameWithOwner --jq .nameWithOwner") echo acme/clinic ;;
  *) exit 1 ;;
esac
`;

/** The browser opener the wizard tries first. */
const FAKE_BROWSER = `#!/bin/sh
echo "$1" >> "$STUB_DIR/opened"
`;

/** The answers that take the wizard to the Sentry token stage, keeping the App's key and the Claude token. */
const TO_THE_SENTRY_STAGE = [
  "", // Ready to start?
  "fabrik-factory", // the Fabrik App's slug
  "", // the App is installed on the repo
  "", // 1Password holds the App's key
  "n", // keep the Claude token
  "",
];

/** 1Password's items, as "vault/title", once the App's key and the Claude token are stored. */
const THE_APP_AND_CLAUDE = ["Fabrik App/Fabrik App", "Fabrik/Claude token"];

interface OpCall {
  args: string[];
  template: unknown;
}

interface Walk {
  status: number | null;
  stdout: string;
  op: OpCall[];
  opened: string[];
}

async function stub(bin: string, name: string, script: string): Promise<void> {
  await writeFile(join(bin, name), script);
  await chmod(join(bin, name), 0o755);
}

async function linesOf(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/**
 * Walks the wizard with 1Password holding `items`, answering `answers` in turn
 * and then nothing, which every stage after the Sentry token's takes as Enter or No.
 */
async function walk(items: string[], answers: string[]): Promise<Walk> {
  const bin = await tempDir("wizard-bin");
  await stub(bin, "op", FAKE_OP);
  await stub(bin, "gh", FAKE_GH);
  await stub(bin, "wslview", FAKE_BROWSER);
  const checkout = await tempDir("wizard-checkout");
  const run = spawnSync("bash", [WIZARD], {
    cwd: checkout,
    input: answers.map((a) => `${a}\n`).join(""),
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      STUB_DIR: bin,
      STUB_OP_ITEMS: JSON.stringify(items),
    },
  });
  return {
    status: run.status,
    stdout: run.stdout,
    op: (await linesOf(join(bin, "op.log"))).map((l) => JSON.parse(l) as OpCall),
    opened: await linesOf(join(bin, "opened")),
  };
}

/** What `op item create` stored, by vault. */
function created(w: Walk): { vault: string | undefined; item: unknown }[] {
  return w.op
    .filter((c) => c.args[0] === "item" && c.args[1] === "create")
    .map((c) => ({ vault: c.args[c.args.indexOf("--vault") + 1], item: c.template }));
}

/** Each `op item delete` call's arguments. */
function deleted(w: Walk): string[][] {
  return w.op.filter((c) => c.args[0] === "item" && c.args[1] === "delete").map((c) => c.args);
}

describe("The setup wizard's Fabrik App stage", () => {
  it("asks for Checks: read beside the App's other permissions, and how to accept it on an installation", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE);

    expect(w.stdout).toContain(
      "It needs Issues, Pull requests and Contents (read and write), Checks (read), and never 'workflows'.",
    );
    expect(w.stdout).toContain("https://github.com/settings/apps/fabrik-factory/permissions");
  });
});

describe("The setup wizard's Sentry token stage", () => {
  it("opens Sentry's token page and names the scopes the token needs", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "y", "sntryu_0123abcd"]);

    expect(w.opened).toContain("https://sentry.io/settings/account/api/auth-tokens/new-token/");
    expect(w.stdout).toContain("event:read");
    expect(w.stdout).toContain("project:read");
  });

  it("stores the pasted token as the 'Sentry token' API Credential in the 'Fabrik App' vault", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "y", "sntryu_0123abcd"]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([
      {
        vault: "Fabrik App",
        item: {
          title: "Sentry token",
          category: "API_CREDENTIAL",
          fields: [{ id: "credential", type: "CONCEALED", label: "credential", value: "sntryu_0123abcd" }],
        },
      },
    ]);
  });

  it("refuses an organization auth token, whose scopes don't cover issues, and leaves the token to do by hand", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "y", "sntrys_eyJpYXQiOjE3"]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(w.stdout).toMatch(/still to do by hand:\n.*the 'Sentry token' item in the 'Fabrik App' vault/);
  });

  it("keeps the token 1Password holds when the replacement is an organization auth token", async () => {
    const w = await walk([...THE_APP_AND_CLAUDE, "Fabrik App/Sentry token"], [...TO_THE_SENTRY_STAGE, "y", "sntrys_eyJpYXQiOjE3"]);

    expect(deleted(w)).toEqual([]);
    expect(created(w)).toEqual([]);
    expect(w.stdout).toContain("Keeping the current Sentry token.");
    expect(w.stdout).not.toContain("still to do by hand");
  });

  it("is skipped for a repo that doesn't report to Sentry, which still finishes setup", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "n"]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(w.stdout).toContain("Setup complete");
  });

  it("keeps the Sentry token 1Password already holds, which every Product repo shares", async () => {
    const w = await walk([...THE_APP_AND_CLAUDE, "Fabrik App/Sentry token"], [...TO_THE_SENTRY_STAGE, "n"]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(deleted(w)).toEqual([]);
    expect(w.stdout).toContain("Keeping the current Sentry token.");
  });

  it("replaces the token 1Password holds on request, archiving the old one so it stays in the item's history", async () => {
    const w = await walk([...THE_APP_AND_CLAUDE, "Fabrik App/Sentry token"], [...TO_THE_SENTRY_STAGE, "y", "sntryu_new"]);

    expect(deleted(w)).toEqual([["item", "delete", "Sentry token", "--vault", "Fabrik App", "--archive"]]);
    expect(created(w)).toEqual([
      {
        vault: "Fabrik App",
        item: {
          title: "Sentry token",
          category: "API_CREDENTIAL",
          fields: [{ id: "credential", type: "CONCEALED", label: "credential", value: "sntryu_new" }],
        },
      },
    ]);
  });
});
