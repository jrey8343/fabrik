// The setup wizard is the half of /fabrik-setup the Operator runs in their own
// terminal, so it's run here as they'd run it: with `gh`, `op` and the browser
// stubbed, and their answers piped in.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const found = items.includes(flag("--vault") + "/" + args[2]);
  if (found && flag("--format") === "json") process.stdout.write(JSON.stringify({ id: "id of " + args[2], title: args[2] }));
  process.exit(found ? 0 : 1);
}
if (args[0] === "item" && args[1] === "create" && process.env.STUB_OP_CREATE_FAILS === "1") process.exit(1);
`;

/** A `gh` in acme/clinic's checkout that answers `gh api` from the STUB_GH_API routes, by path without its query, and fails anything else. */
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "repo view --json nameWithOwner --jq .nameWithOwner") { console.log("acme/clinic"); process.exit(0); }
if (args[0] === "repo" && args[1] === "view" && args[2] === "jrey8343/fabrik-runs") process.exit(process.env.STUB_GH_STORE === "1" ? 0 : 1);
if (args[0] === "api") {
  const routes = JSON.parse(process.env.STUB_GH_API || "{}");
  const path = args[1].split("?")[0];
  if (path in routes) { process.stdout.write(JSON.stringify(routes[path])); process.exit(0); }
}
process.exit(1);
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

interface WalkOptions {
  /** `op item create` fails. */
  createFails?: boolean;
  /** What `gh api` answers, by path without its query. */
  ghApi?: Record<string, unknown>;
  /** The fabrik-runs store exists. */
  store?: boolean;
  /** The checkout's .env, when it has one. */
  dotEnv?: string;
  /** The OP_ACCOUNT Setup passes in, naming the 1Password account. Unset when not given. */
  opAccount?: string;
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
 * `kitConfig` is the checkout's .fabrik/config.json, when it has one.
 */
async function walk(
  items: string[],
  answers: string[],
  kitConfig?: string,
  { createFails = false, ghApi = {}, store = false, dotEnv, opAccount }: WalkOptions = {},
): Promise<Walk> {
  const bin = await tempDir("wizard-bin");
  await stub(bin, "op", FAKE_OP);
  await stub(bin, "gh", FAKE_GH);
  await stub(bin, "wslview", FAKE_BROWSER);
  const checkout = await tempDir("wizard-checkout");
  if (kitConfig !== undefined) {
    await mkdir(join(checkout, ".fabrik"));
    await writeFile(join(checkout, ".fabrik", "config.json"), kitConfig);
  }
  if (dotEnv !== undefined) await writeFile(join(checkout, ".env"), dotEnv);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    STUB_DIR: bin,
    STUB_OP_ITEMS: JSON.stringify(items),
    STUB_OP_CREATE_FAILS: createFails ? "1" : "0",
    STUB_GH_API: JSON.stringify(ghApi),
    STUB_GH_STORE: store ? "1" : "0",
  };
  // Never the account of the shell running the tests.
  delete env["OP_ACCOUNT"];
  if (opAccount !== undefined) env["OP_ACCOUNT"] = opAccount;
  const run = spawnSync("bash", [WIZARD], {
    cwd: checkout,
    input: answers.map((a) => `${a}\n`).join(""),
    encoding: "utf8",
    timeout: 30_000,
    env,
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

  /** A comment or issue made through the App `slug`, which the GitHub user `owner` owns. */
  const actedOnBy = (slug: string, owner: string) => ({ body: "…", performed_via_github_app: { slug, owner: { login: owner } } });
  const OPERATOR = { user: { login: "jrey8343" } };
  /** The answers to the App stage that take the default slug, then the rest of TO_THE_SENTRY_STAGE. */
  const TAKING_THE_DEFAULT = ["", "", "", "", "n", ""];
  /** TAKING_THE_DEFAULT, with the fabrik-runs store's installation stage after the repo's. */
  const TAKING_THE_DEFAULT_WITH_THE_STORE = ["", "", "", "", "", "n", ""];

  it("offers the slug of the Operator's own App that has commented on the repo as the default", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TAKING_THE_DEFAULT, undefined, {
      ghApi: { ...OPERATOR, "repos/acme/clinic/issues/comments": [actedOnBy("fabrik-factory", "jrey8343"), { body: "a human" }] },
    });

    expect(w.status).toBe(0);
    expect(w.stdout).toContain("Your App fabrik-factory already acts on acme/clinic");
    expect(w.opened).not.toContain("https://github.com/settings/apps");
    expect(w.stdout).toContain("https://github.com/settings/apps/fabrik-factory/permissions");
    expect(w.opened).toContain("https://github.com/apps/fabrik-factory/installations/new");
  });

  it("offers the Operator's App that has acted only on the fabrik-runs store, such as by filing the Weekly summary", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TAKING_THE_DEFAULT_WITH_THE_STORE, undefined, {
      store: true,
      ghApi: { ...OPERATOR, "repos/jrey8343/fabrik-runs/issues": [actedOnBy("fabrik-factory", "jrey8343")] },
    });

    expect(w.stdout).toContain("Your App fabrik-factory already acts on acme/clinic");
    expect(w.opened).toContain("https://github.com/apps/fabrik-factory/installations/new");
  });

  it("never offers an App the Operator doesn't own, such as github-actions or Dependabot", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE, undefined, {
      ghApi: {
        ...OPERATOR,
        "repos/acme/clinic/issues/comments": [actedOnBy("github-actions", "github"), actedOnBy("dependabot", "github")],
      },
    });

    expect(w.stdout).not.toContain("Your App");
    expect(w.stdout).not.toContain("github-actions");
    expect(w.stdout).not.toContain("dependabot");
    expect(w.opened).toContain("https://github.com/settings/apps");
  });

  it("with no App found, opens the Operator's own Apps and says where the slug is before asking", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE, undefined, {
      ghApi: { ...OPERATOR, "repos/acme/clinic/issues/comments": [] },
    });

    expect(w.status).toBe(0);
    expect(w.opened[0]).toBe("https://github.com/settings/apps");
    expect(w.stdout).toContain("its slug is the last part of the page's URL, github.com/settings/apps/<slug>");
    expect(w.opened).toContain("https://github.com/apps/fabrik-factory/installations/new");
  });

  it("lists each of the Operator's Apps when it finds more than one, and asks which", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE, undefined, {
      ghApi: {
        ...OPERATOR,
        "repos/acme/clinic/issues/comments": [actedOnBy("fabrik-factory", "jrey8343"), actedOnBy("fabrik-factory", "jrey8343")],
        "repos/acme/clinic/issues": [actedOnBy("other-bot", "jrey8343")],
      },
    });

    expect(w.stdout).toMatch(/More than one of your Apps acts on acme\/clinic:\n.*• fabrik-factory\n.*• other-bot\n/);
    expect(w.opened[0]).toBe("https://github.com/settings/apps");
    expect(w.opened).toContain("https://github.com/apps/fabrik-factory/installations/new");
  });

  it.each([
    ["gh api fails on every lookup", {}],
    ["gh api answers with something other than a list", { ...OPERATOR, "repos/acme/clinic/issues/comments": { message: "API rate limit exceeded" } }],
  ])("falls back to the guided prompt, not an exit, when %s", async (_, ghApi) => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE, undefined, { ghApi });

    expect(w.status).toBe(0);
    expect(w.opened[0]).toBe("https://github.com/settings/apps");
    expect(w.stdout).toContain("Setup complete");
  });

  it("takes a slug the Operator types over the one it found", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, ["", "my-other-app", "", "", "n", ""], undefined, {
      ghApi: { ...OPERATOR, "repos/acme/clinic/issues/comments": [actedOnBy("fabrik-factory", "jrey8343")] },
    });

    expect(w.opened).toContain("https://github.com/apps/my-other-app/installations/new");
    expect(w.opened).not.toContain("https://github.com/apps/fabrik-factory/installations/new");
  });

  it("keeps a slug saved in .env by an earlier run as the default, without looking it up or opening the Apps list", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TAKING_THE_DEFAULT, undefined, {
      dotEnv: "FABRIK_APP_SLUG='saved-app'\n",
      ghApi: { ...OPERATOR, "repos/acme/clinic/issues/comments": [actedOnBy("fabrik-factory", "jrey8343")] },
    });

    expect(w.stdout).not.toContain("Your App");
    expect(w.opened[0]).toBe("https://github.com/apps/saved-app/installations/new");
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

  it("keeps the Sentry token 1Password already holds, which every Product repo in this 1Password account shares", async () => {
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

describe("The setup wizard in one 1Password account per Product", () => {
  /** The account as the wizard words it, and the OP_ACCOUNT Setup passes in to name it, if any. */
  const ACCOUNTS: [string, string | undefined][] = [
    ["this 1Password account", undefined],
    ["this 1Password account (clinic.1password.com)", "clinic.1password.com"],
  ];

  it.each(ACCOUNTS)("says the Claude and Sentry tokens 1Password holds are shared by every Product repo in %s", async (account, opAccount) => {
    const w = await walk([...THE_APP_AND_CLAUDE, "Fabrik App/Sentry token"], [...TO_THE_SENTRY_STAGE, "n"], undefined, { opAccount });

    expect(w.stdout).toContain(`1Password already holds a Claude token, which every Product repo in ${account} shares. Replace it with a new one?`);
    expect(w.stdout).toContain(`1Password already holds a Sentry token, which every Product repo in ${account} shares. Replace it with a new one?`);
    expect(w.stdout).not.toContain("which every Product repo shares");
  });

  /** The answers that walk a new account's App key and Claude token stages: a key file that isn't there, then a token. */
  const IN_A_NEW_ACCOUNT = ["", "fabrik-factory", "", "Iv1.0123abcd", "/nowhere/fabrik.pem", "sk-ant-oat01-first", ""];

  it.each(ACCOUNTS)("says an App key and a Claude token not stored yet in %s are expected for a new account", async (account, opAccount) => {
    const w = await walk([], IN_A_NEW_ACCOUNT, undefined, { opAccount });

    expect(w.status).toBe(0);
    expect(w.stdout).toContain(`There's no 'Fabrik App' item in ${account} yet. That's expected for a new account.`);
    expect(w.stdout).toContain(`There's no Claude token in ${account} yet. That's expected for a new account.`);
  });

  it("doesn't call the account new when it already holds the App key and the Claude token", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE);

    expect(w.stdout).not.toContain("expected for a new account");
  });
});

describe("The setup wizard's second Subscription stage", () => {
  /** Past the Sentry stage, skipping it, to the second Subscription's opt-in. */
  const TO_THE_SECOND_SUBSCRIPTION = [...TO_THE_SENTRY_STAGE, "n", ""];
  const ADDING_IT = [
    ...TO_THE_SECOND_SUBSCRIPTION,
    "y", // add a second Subscription
    "", // the second account exists
    "sk-ant-oat01-second", // its token
    "", // usage credits are off on every account
  ];
  const BOTH_LISTED = '{ "subscriptions": ["Claude token", "Claude token 2"] }\n';

  it("walks through the second account, `claude setup-token`, usage credits off on every account and the Kit config list", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT);

    expect(w.stdout).toContain("Create a second Claude account");
    expect(w.stdout).toContain("run: claude setup-token");
    expect(w.stdout).toContain("signed in as the second account");
    expect(w.opened).toContain("https://claude.ai/settings/usage");
    expect(w.stdout).toContain("turn usage credits off on every account, the first one included");
    expect(w.stdout).toContain('"subscriptions": ["Claude token", "Claude token 2"]');
  });

  it("stores the second token as the 'Claude token 2' API Credential, with its expiry date, in the 'Fabrik' vault", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([
      {
        vault: "Fabrik",
        item: {
          title: "Claude token 2",
          category: "API_CREDENTIAL",
          fields: [
            { id: "credential", type: "CONCEALED", label: "credential", value: "sk-ant-oat01-second" },
            { id: "expires", type: "DATE", label: "expires", value: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown },
          ],
        },
      },
    ]);
  });

  it("leaves listing it in the Kit config to do by hand until .fabrik/config.json lists it", async () => {
    const unlisted = await walk(THE_APP_AND_CLAUDE, ADDING_IT);
    const listed = await walk(THE_APP_AND_CLAUDE, ADDING_IT, BOTH_LISTED);

    expect(unlisted.stdout).toMatch(/still to do by hand:\n.*"Claude token 2" in subscriptions in \.fabrik\/config\.json/);
    expect(listed.stdout).toContain(".fabrik/config.json lists both Subscriptions.");
    expect(listed.stdout).not.toContain("still to do by hand");
  });

  it("is skipped unless the Operator asks for a second Subscription, which still finishes setup", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SECOND_SUBSCRIPTION);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(w.stdout).not.toContain("Create a second Claude account");
    expect(w.stdout).toContain("Setup complete");
  });

  const REPLACING_IT = [...TO_THE_SECOND_SUBSCRIPTION, "y", "sk-ant-oat01-new", ""];

  it("replaces the second token by storing the new one first, then archiving the old item by its id", async () => {
    const w = await walk([...THE_APP_AND_CLAUDE, "Fabrik/Claude token 2"], REPLACING_IT, BOTH_LISTED);

    expect(w.status).toBe(0);
    const writes = w.op.filter((c) => c.args[0] === "item" && (c.args[1] === "create" || c.args[1] === "delete"));
    expect(writes.map((c) => c.args.slice(0, 3))).toEqual([
      ["item", "create", "--vault"],
      ["item", "delete", "id of Claude token 2"],
    ]);
    expect(deleted(w)).toEqual([["item", "delete", "id of Claude token 2", "--vault", "Fabrik", "--archive"]]);
  });

  it("leaves the old second token in place when storing the new one fails", async () => {
    const w = await walk([...THE_APP_AND_CLAUDE, "Fabrik/Claude token 2"], REPLACING_IT, BOTH_LISTED, { createFails: true });

    expect(w.status).not.toBe(0);
    expect(deleted(w)).toEqual([]);
  });

  it("keeps the second token 1Password already holds, and still checks usage credits and the Kit config list", async () => {
    const w = await walk([...THE_APP_AND_CLAUDE, "Fabrik/Claude token 2"], [...TO_THE_SECOND_SUBSCRIPTION, "n"], BOTH_LISTED);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(deleted(w)).toEqual([]);
    expect(w.stdout).toContain("Keeping the current second token.");
    expect(w.stdout).toContain("turn usage credits off on every account, the first one included");
    expect(w.stdout).toContain(".fabrik/config.json lists both Subscriptions.");
  });
});

describe("The setup wizard's Visual evidence stage", () => {
  /** Past the Sentry and second Subscription stages, skipping both, to Visual evidence's opt-in. */
  const TO_VISUAL_EVIDENCE = [...TO_THE_SENTRY_STAGE, "n", "", "n", ""];
  const UI_ON = JSON.stringify({ ui: { paths: ["src/pages/**"], serve: "npm run preview", url: "http://localhost:4321" } });

  it("is skipped unless the Operator asks for it, which still finishes setup", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_VISUAL_EVIDENCE);

    expect(w.status).toBe(0);
    expect(w.stdout).toContain("Turn on Visual evidence for acme/clinic?");
    expect(w.stdout).toContain("Skipping Visual evidence.");
    expect(w.stdout).not.toContain("still to do by hand");
    expect(w.stdout).toContain("Setup complete");
  });

  it("sends an Operator who wants it to /fabrik-setup's Visual evidence step, which writes the Kit config, and lists it to do", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_VISUAL_EVIDENCE, "y"]);

    expect(w.status).toBe(0);
    expect(w.stdout).toContain("ui.paths");
    expect(w.stdout).toMatch(/still to do by hand:\n.*run \/fabrik-setup again and answer its Visual evidence step/);
  });

  it("says Visual evidence is on, and asks nothing, once .fabrik/config.json has a ui block", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_VISUAL_EVIDENCE, UI_ON);

    expect(w.status).toBe(0);
    expect(w.stdout).toContain(".fabrik/config.json has a ui block, so UI pull requests get Visual evidence.");
    expect(w.stdout).not.toContain("Turn on Visual evidence");
    expect(w.stdout).not.toContain("still to do by hand");
  });
});
