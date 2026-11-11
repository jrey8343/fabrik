// The setup wizard is the part of Setup the Operator walks in their own
// terminal, so it's run here as they'd walk it: with `gh`, `op` and the
// browser stubbed, and their answers piped in.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";
import { WIZARD_PATH as WIZARD, WIZARD_REPORT_ENV, WIZARD_SECOND_SUBSCRIPTION_ENV } from "./wizard.ts";

/**
 * An `op` that holds the given "vault/title" items, and logs each call with the
 * template it was given, from a file or, after a lone -, on stdin.
 */
const FAKE_OP = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const file = flag("--template");
const text = file !== null ? readFileSync(file, "utf8") : args.includes("-") ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.STUB_DIR + "/op.log", JSON.stringify({
  args, templateFile: file, template: text === null ? null : JSON.parse(text),
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

/** The account as the wizard words it, and the OP_ACCOUNT Setup passes in to name it, if any. */
const ACCOUNTS: [string, string | undefined][] = [
  ["this 1Password account", undefined],
  ["this 1Password account (clinic.1password.com)", "clinic.1password.com"],
];

interface OpCall {
  args: string[];
  /** Where the template was, when op was given one by its path. */
  templateFile: string | null;
  template: unknown;
}

interface Walk {
  status: number | null;
  stdout: string;
  op: OpCall[];
  opened: string[];
  /** What the wizard reported to setup, a line each, when setup ran it. */
  report: string[];
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
  /** Setup runs the wizard, and gives it a file to report to. */
  bySetup?: boolean;
  /** When Setup runs it, the Operator's answer to Setup's second Subscription question. */
  secondSubscription?: boolean;
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
  { createFails = false, ghApi = {}, store = false, dotEnv, opAccount, bySetup = false, secondSubscription = false }: WalkOptions = {},
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
  delete env[WIZARD_REPORT_ENV];
  if (bySetup) env[WIZARD_REPORT_ENV] = join(bin, "report");
  delete env[WIZARD_SECOND_SUBSCRIPTION_ENV];
  if (bySetup) env[WIZARD_SECOND_SUBSCRIPTION_ENV] = secondSubscription ? "yes" : "no";
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
    report: await linesOf(join(bin, "report")),
  };
}

/** What `op item create` stored, by vault. */
function created(w: Walk): { vault: string | undefined; item: unknown }[] {
  return w.op
    .filter((c) => c.args[0] === "item" && c.args[1] === "create")
    .map((c) => ({ vault: c.args[c.args.indexOf("--vault") + 1], item: c.template }));
}

/** The template files `op item create` was given that are still on disk. */
function templatesLeft(w: Walk): string[] {
  return w.op.flatMap((c) => (c.templateFile !== null && existsSync(c.templateFile) ? [c.templateFile] : []));
}

/** Each `op item delete` call's arguments. */
function deleted(w: Walk): string[][] {
  return w.op.filter((c) => c.args[0] === "item" && c.args[1] === "delete").map((c) => c.args);
}

describe("The setup wizard's Fabrik App stage", () => {
  it("asks for Checks: read beside the App's other permissions, and how to accept it on an installation", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE);

    expect(w.stdout).toContain(
      "It needs Issues, Pull requests and Contents (read and write), Checks (read), Actions (read), and never 'workflows'.",
    );
    expect(w.stdout).toContain("https://github.com/settings/apps/fabrik-factory/permissions");
  });

  it("tells setup the App is on the repo once the Operator presses Enter at that step, since setup can't read it for itself", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE, undefined, { bySetup: true });

    expect(w.status).toBe(0);
    expect(w.report).toEqual(["app-installed acme/clinic"]);
  });

  it("tells setup nothing about the App when the Operator's input ends before that Enter", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, ["", "fabrik-factory"], undefined, { bySetup: true });

    expect(w.status).toBe(0);
    expect(w.report).toEqual([]);
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

describe("The setup wizard's Fabrik App key stage", () => {
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0fabrik\n-----END RSA PRIVATE KEY-----\n";

  it("stores the Client ID and the key file's private key as the 'Fabrik App' item, the key never in op's arguments", async () => {
    const downloads = await tempDir("wizard-downloads");
    const key = join(downloads, "fabrik.pem");
    await writeFile(key, PEM);

    const w = await walk(["Fabrik/Claude token"], ["", "fabrik-factory", "", "Iv1.0123abcd", key, "n", "n", ""]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([
      {
        vault: "Fabrik App",
        item: {
          title: "Fabrik App",
          category: "SECURE_NOTE",
          fields: [
            { id: "client-id", type: "STRING", label: "client-id", value: "Iv1.0123abcd" },
            { id: "private-key", type: "CONCEALED", label: "private-key", value: PEM },
          ],
        },
      },
    ]);
    expect(w.op.filter((c) => c.args.some((arg) => arg.includes("PRIVATE KEY")))).toEqual([]);
    expect(w.stdout).toContain("stored the 'Fabrik App' item in 1Password");
  });
});

describe("The setup wizard's Claude token stage", () => {
  /** To the Claude token's paste, 1Password holding the App's key. */
  const TO_THE_PASTE = ["", "fabrik-factory", "", ""];

  it("stores nothing when the Operator pastes nothing, and leaves the token to do", async () => {
    const w = await walk(["Fabrik App/Fabrik App"], [...TO_THE_PASTE, "", ""]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(deleted(w)).toEqual([]);
    expect(w.stdout).toContain("No token pasted.");
    expect(w.stdout).not.toContain("stored the Claude token");
    expect(w.stdout).toMatch(/still to do by hand:\n.*the 'Claude token' API Credential in the 'Fabrik' vault/);
  });

  it("leaves no copy of the token on disk when 1Password doesn't store it", async () => {
    const w = await walk(["Fabrik App/Fabrik App"], [...TO_THE_PASTE, "sk-ant-oat01-first", ""], undefined, { createFails: true });

    expect(w.status).not.toBe(0);
    expect(created(w)).toHaveLength(1);
    expect(templatesLeft(w)).toEqual([]);
  });

  it("keeps the token 1Password holds when the replacement pasted is nothing", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_PASTE, "y", "", ""]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(deleted(w)).toEqual([]);
    expect(w.stdout).toContain("Keeping the current token.");
    expect(w.stdout).not.toContain("still to do by hand");
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

  it("leaves no copy of the token on disk when 1Password doesn't store it", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "y", "sntryu_0123abcd"], undefined, { createFails: true });

    expect(w.status).not.toBe(0);
    expect(created(w)).toHaveLength(1);
    expect(templatesLeft(w)).toEqual([]);
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

  it("asks whether to store a Sentry token now, not whether the repo reports to Sentry", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "n"]);

    expect(w.stdout).toContain("Store a Sentry token now?");
    expect(w.stdout).not.toContain("report production errors to Sentry?");
  });

  it.each(ACCOUNTS)("says, before asking, that the token is shared by every Product repo in %s, harmless before acme/clinic reports, and fine to skip", async (account, opAccount) => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "n"], undefined, { opAccount });

    const explained = w.stdout.indexOf(`One Sentry token serves every Product repo in ${account}.`);
    expect(explained).toBeGreaterThan(-1);
    expect(explained).toBeLessThan(w.stdout.indexOf("Store a Sentry token now?"));
    expect(w.stdout).toContain(
      "Storing it before acme/clinic reports to Sentry is harmless: the Monitor doesn't read Sentry until monitor.errors names a project.",
    );
    expect(w.stdout).toContain("Skipping is fine too: once monitor.errors names a project, running Setup again walks this stage.");
  });

  it("is skipped on a no, which still finishes setup, and says how to store a token later without assuming the repo doesn't use Sentry", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_THE_SENTRY_STAGE, "n"]);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(w.stdout).toContain("Setup complete");
    expect(w.stdout).toContain(
      "Skipping the Sentry token. To store one later, name a project in monitor.errors in .fabrik/config.json and run Setup again: it walks this stage while 1Password lacks the token.",
    );
    expect(w.stdout).not.toContain("Once acme/clinic reports to Sentry");
    expect(w.stdout).not.toContain("Re-run the wizard");
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

  it("walks through the second account, `claude setup-token` and usage credits off on every account", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT);

    expect(w.stdout).toContain("Create a second Claude account");
    expect(w.stdout).toContain("run: claude setup-token");
    expect(w.stdout).toContain("signed in as the second account");
    expect(w.opened).toContain("https://claude.ai/settings/usage");
    expect(w.stdout).toContain("turn usage credits off on every account, the first one included");
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

  it("says Setup lists the token it stored in the setup PR, when Setup runs the wizard on a yes to a second Subscription", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT, undefined, { bySetup: true, secondSubscription: true });

    expect(w.status).toBe(0);
    expect(w.stdout).toContain("Setup lists it in subscriptions in .fabrik/config.json, after the first, in the setup PR.");
    expect(w.stdout).not.toContain('"subscriptions": [');
    expect(w.stdout).not.toContain("still to do by hand");
  });

  it("otherwise says to run Setup again and say yes, which lists it, rather than to list it by hand", async () => {
    for (const options of [{}, { bySetup: true, secondSubscription: false }]) {
      const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT, undefined, options);

      expect(w.stdout).toContain("To list it in subscriptions in .fabrik/config.json, run Setup again and say yes to a second Subscription.");
      expect(w.stdout).toMatch(/still to do by hand:\n.*list "Claude token 2" in subscriptions in \.fabrik\/config\.json: run Setup again and say yes to a second Subscription/);
      expect(w.stdout).not.toContain('"subscriptions": [');
    }
  });

  it("says .fabrik/config.json lists it, and leaves nothing to do, once it does", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT, BOTH_LISTED);

    expect(w.stdout).toContain(".fabrik/config.json lists 'Claude token 2' already.");
    expect(w.stdout).not.toContain("still to do by hand");
  });

  it("says nothing about listing a token it didn't store", async () => {
    const noToken = [...TO_THE_SECOND_SUBSCRIPTION, "y", "", "", ""];

    const w = await walk(THE_APP_AND_CLAUDE, noToken, undefined, { bySetup: true, secondSubscription: true });

    expect(w.stdout).toContain("No token pasted.");
    expect(w.stdout).not.toMatch(/lists it in subscriptions|To list it|"subscriptions": \[/);
  });

  it("is skipped unless the Operator asks for a second Subscription, which still finishes setup, and says how Setup adds one later", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SECOND_SUBSCRIPTION);

    expect(w.status).toBe(0);
    expect(created(w)).toEqual([]);
    expect(w.stdout).not.toContain("Create a second Claude account");
    expect(w.stdout).toContain("Setup complete");
    expect(w.stdout).toContain(
      "Skipping the second Subscription. To add one later, run Setup again and say yes to a second Subscription: it walks this stage while 1Password lacks the token.",
    );
    expect(w.stdout).not.toContain("Re-run the wizard");
  });

  describe("with .fabrik/config.json listing two or more Subscriptions, which Setup leaves as they are", () => {
    const ROTATION = '{ "subscriptions": ["Claude token", "Claude backup"] }\n';

    it("says to list the token it stored by hand, not that Setup lists it or to say yes to Setup", async () => {
      for (const secondSubscription of [true, false]) {
        const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT, ROTATION, { bySetup: true, secondSubscription });

        expect(w.status).toBe(0);
        expect(w.stdout).toContain(
          "Setup leaves the subscriptions list in .fabrik/config.json as it is, since it lists two or more. To run on 'Claude token 2' too, add it to that list yourself.",
        );
        expect(w.stdout).toMatch(/still to do by hand:\n.*list "Claude token 2" in subscriptions in \.fabrik\/config\.json yourself: Setup leaves a list of two or more as it is/);
        expect(w.stdout).not.toMatch(/Setup lists it|say yes to a second Subscription/);
      }
    });

    it("skipped, says Setup leaves that list as it is, not how Setup adds one later", async () => {
      const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SECOND_SUBSCRIPTION, ROTATION, { bySetup: true });

      expect(w.status).toBe(0);
      expect(w.stdout).toContain("Skipping the second Subscription. .fabrik/config.json already lists two or more Subscriptions, and Setup leaves that list as it is.");
      expect(w.stdout).not.toContain("say yes to a second Subscription");
    });

    it("skipped while the list names the second Subscription, says running Setup again walks this stage, with no yes to give", async () => {
      const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SECOND_SUBSCRIPTION, BOTH_LISTED, { bySetup: true });

      expect(w.stdout).toContain(
        "Skipping the second Subscription. .fabrik/config.json lists 'Claude token 2' already, so running Setup again walks this stage while 1Password lacks its token.",
      );
      expect(w.stdout).not.toContain("say yes to a second Subscription");
    });
  });

  describe("with .fabrik/config.json listing the second Subscription alone, which Setup has nothing to list for", () => {
    const ALONE = '{ "subscriptions": ["Claude token 2"] }\n';

    it("says it's listed, and leaves nothing to do, once it stores the token", async () => {
      for (const secondSubscription of [true, false]) {
        const w = await walk(THE_APP_AND_CLAUDE, ADDING_IT, ALONE, { bySetup: true, secondSubscription });

        expect(w.status).toBe(0);
        expect(w.stdout).toContain("✓ stored the 'Claude token 2' token");
        expect(w.stdout).toContain(".fabrik/config.json lists 'Claude token 2' already.");
        expect(w.stdout).not.toMatch(/Setup lists it|To list it|say yes to a second Subscription|still to do by hand/);
      }
    });

    it("skipped, says running Setup again walks this stage, with no yes to give", async () => {
      const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SECOND_SUBSCRIPTION, ALONE, { bySetup: true });

      expect(w.stdout).toContain(
        "Skipping the second Subscription. .fabrik/config.json lists 'Claude token 2' already, so running Setup again walks this stage while 1Password lacks its token.",
      );
      expect(w.stdout).not.toContain("say yes to a second Subscription");
    });
  });

  const REPLACING_IT =[...TO_THE_SECOND_SUBSCRIPTION, "y", "sk-ant-oat01-new", ""];

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
    expect(w.stdout).toContain(".fabrik/config.json lists 'Claude token 2' already.");
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
    expect(w.stdout).toContain("Skipping Visual evidence. Run /fabrik-visual-evidence in a Claude session in this repo to turn it on later.");
    expect(w.stdout).not.toContain("still to do by hand");
    expect(w.stdout).toContain("Setup complete");
  });

  it("sends an Operator who wants it to /fabrik-visual-evidence, which writes the Kit config, and lists it to do", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, [...TO_VISUAL_EVIDENCE, "y"]);

    expect(w.status).toBe(0);
    expect(w.stdout).toContain("ui.paths");
    expect(w.stdout).toMatch(/still to do by hand:\n.*turn on Visual evidence: run \/fabrik-visual-evidence in a Claude session in this repo/);
    expect(w.stdout).not.toContain("/fabrik-setup");
  });

  it("says Visual evidence is on, and asks nothing, once .fabrik/config.json has a ui block", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_VISUAL_EVIDENCE, UI_ON);

    expect(w.status).toBe(0);
    expect(w.stdout).toContain(".fabrik/config.json has a ui block, so UI pull requests get Visual evidence.");
    expect(w.stdout).not.toContain("Turn on Visual evidence");
    expect(w.stdout).not.toContain("still to do by hand");
  });
});

describe("The setup wizard run by setup", () => {
  it("ends handing back to Setup, not saying to open an issue, and promises no setup PR, which a run that writes no file doesn't open", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE, undefined, { bySetup: true });

    expect(w.status).toBe(0);
    expect(w.stdout).toContain("Next: back to Setup, which says what it did and what's left.");
    expect(w.stdout).not.toContain("opens the setup PR");
    expect(w.stdout).not.toContain("Next: open an issue");
  });

  it("ends saying the wizard is done, not Setup, which carries on", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE, undefined, { bySetup: true });

    expect(w.stdout).toContain("✓ The wizard is done");
    expect(w.stdout).not.toContain("Setup complete");
  });

  it("run on its own, still ends by saying to open an issue, and reports nothing", async () => {
    const w = await walk(THE_APP_AND_CLAUDE, TO_THE_SENTRY_STAGE);

    expect(w.stdout).toContain("✓ Setup complete");
    expect(w.stdout).toContain("Next: open an issue on acme/clinic.");
    expect(w.report).toEqual([]);
  });
});
