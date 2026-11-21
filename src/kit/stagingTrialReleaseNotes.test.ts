// The notes for the release that ships Staging trials are drafted ahead,
// beside the others (#858). While they are a draft they must say what the
// code does: every field, label, name and export they give is one the code
// holds under that name. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { withCarriedLines } from "../loop/carriedLines.ts";
import { TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL } from "../loop/labels.ts";
import { EXPORT_CALLS, EXPORT_SHAPES } from "../read/exports.fixture.ts";
import {
  aStagingFacts,
  DEFAULT_KIT_CONFIG,
  type DeployOf,
  type Facts,
  homeFactsOf,
  type KitConfig,
  type MainCheckOf,
  type MainChecksRead,
  MERGED_STANDS_HOURS,
  NO_DEPLOY_SEEN_MINUTES,
  type PromoteEntry,
  type PromoteList,
  promoteListOf,
  type readDeployments,
  resolveKitConfig,
  type Row,
  type StagingRead,
  type Standing,
  STANDING_NAMES,
  STANDING_SCHEMA,
  trialProblemIn,
  trialProblemLine,
} from "../read/index.ts";

const NOTES = "docs/release-notes/staging-trials.md";
const NOW = "2026-11-09T12:00:00Z";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Staging trials release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them after the kept Standings notes among the drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: Staging trials");
    expect(notes).toMatch(/^The notes for the minor release that .*\[#814\]\(https:\/\/github\.com\/jrey8343\/fabrik\/issues\/814\)/m);
    expect(notes).toContain("[ADR-0038](../adr/0038-a-staging-trials-result-is-a-label-the-operator-puts-on-the-merged-pull-request.md)");
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain(
      "(release-notes/kept-standings.md), and the Staging trial minor's ([#814](https://github.com/jrey8343/fabrik/issues/814)) are [Staging trials](release-notes/staging-trials.md).",
    );
  });

  it("say the release is a minor and why, in the releasing guide's terms: new Kit config fields with a default, new exports and Standing names, no shim change, no new permission, dormant until turned on", async () => {
    const why = section(await read(NOTES), "Why a minor");
    const releasing = await read("docs/releasing.md");
    // The guide's own terms, which the section answers to.
    expect(releasing).toContain("new behaviour or new Kit config fields. Every new field has a default");
    expect(releasing).toContain("the feature stays dormant until the step is done");
    expect(releasing).toContain("A new export, a new field or a new Standing name is not.");
    expect(releasing).toContain("A new place for a Standing is counted as a new name is, and so is a name a Standing already had when it is said at the new place with a meaning of its own there");

    expect(why).toContain("It adds behaviour, so not a patch.");
    expect(why).toContain("two Kit config fields, `staging` and `production.workflow`, each `null` by default");
    expect(why).toContain("a new export, a new field or a new Standing name is not a major");
    expect(why).toContain("a new place is counted as a new name is");
    expect(why).toContain("`deploying` at Staging also says a deploy that succeeded and whose Main checks have not passed");
    expect(why).toContain("removes nothing the read library exports and changes what none of it means");
    expect(why).toContain("changes no caller or shim");
    expect(why).toContain("no new permission for the Fabrik App");
    expect(why).toContain("stays dormant until");
    expect(why).toContain("**To turn it on**");
  });

  it("say the one thing that changes with no action, and that it is the Loop's only change: a Design session's rewrite keeps a Trial problem's line, in every repo", async () => {
    const noAction = section(await read(NOTES), "What changes with no action");

    expect(noAction).toContain(`a Design session's rewrite of an issue's body now keeps a Trial problem's line, \`${trialProblemLine(50)}\``);
    expect(noAction).toContain("In every repo, with the block or without it");
    expect(noAction).toContain("That is the only change to the Loop.");
    // The rewrite itself: the line outlives it, and a body with none is rewritten to exactly what was written.
    expect(withCarriedLines("## What to build", `The cart total reads 0 on staging.\n\n${trialProblemLine(50)}`)).toBe(`## What to build\n\n${trialProblemLine(50)}`);
    expect(withCarriedLines("## What to build", "The cart total reads 0 on staging.")).toBe("## What to build");
  });

  it("say how to turn it on, in three steps: declare staging in the Operator's own pull request, run Setup again for the two labels, and optionally declare production.workflow; the Pilot first", async () => {
    const turnOn = section(await read(NOTES), "To turn it on");
    const steps = turnOn.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(steps.map((step) => step.slice(0, 3))).toEqual(["1. ", "2. ", "3. "]);
    const [declare, setup, workflow] = steps as [string, string, string];

    expect(declare).toContain("**Declare `staging` in Kit config**");
    expect(declare).toContain("`url`");
    expect(declare).toContain("`environment`");
    expect(declare).toContain("Kit config is a Trust-root file, so this is the Operator's own pull request");
    expect(setup).toContain("**Run Setup again**");
    expect(setup).toContain(`\`${TRIAL_ACCEPTED_LABEL}\``);
    expect(setup).toContain(`\`${TRIAL_PROBLEM_LABEL}\``);
    expect(workflow).toContain("**Optionally, declare `production.workflow`**");
    expect(workflow).toContain("dispatch page");
    // The releasing guide asks of every opt-in step that it is turned on for the Pilot first.
    expect(await read("docs/releasing.md")).toContain("to turn it on for the Pilot first");
    expect(turnOn).toContain("Take them on the Pilot first");
  });

  it("use the glossary's terms for it, and none of the words the glossary says to avoid for them", async () => {
    const notes = await read(NOTES);
    const glossary = await read("GLOSSARY.md");

    for (const term of ["Staging trial", "Trial problem", "Promote list", "Standing", "Main check", "Plain pull request"]) {
      const avoid = new RegExp(`^\\*\\*${term}\\*\\*:\\n.*\\n_Avoid_: (.*)$`, "m").exec(glossary)?.[1];
      expect(avoid, term).toBeDefined();
      expect(notes, term).toContain(term);
      // A word to avoid, without the glossary's note on whose it is, such as "Follow-up (the Reviewer's)".
      const words = (avoid ?? "").split(", ").map((word) => word.replace(/ \(.*\)$/, ""));
      expect(
        words.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(notes)),
        term,
      ).toEqual([]);
    }
  });

  it("give only the figures the code holds: the 24 hours a settled Standing lasts, the hour before No deploy seen, the 100 merges a Promote list holds and the Standing's schema", async () => {
    const notes = await read(NOTES);
    const hours = [...notes.matchAll(/(\d+) hours?\b/g)].map((match) => Number(match[1]));
    const mostRecent = [...notes.matchAll(/the (\d+) most recent/g)].map((match) => Number(match[1]));
    // A repo that declares staging, with more Plain pull requests merged since the list's start than a list holds.
    const merges = Array.from({ length: 250 }, (_, at) => ({ number: 1000 - at, title: "Fix a typo", mergedAt: new Date(Date.parse(NOW) - at * 60_000).toISOString(), author: "operator", headRef: "fix-typo", closes: [] }));
    const list = promoteListOf(
      homeFactsOf({
        kit: { repo: "owner/product", branch: "main", config: { ok: true, config: { ...DEFAULT_KIT_CONFIG, staging: { url: "https://staging.shop.example", environment: "staging" } } }, dispatch: null },
        staging: aStagingFacts({
          since: { from: "staging", deployment: 1, commit: "s".repeat(40), at: "2026-11-01T09:00:00Z", deployedAt: "2026-11-01T09:05:00Z" },
          plain: merges,
          mergedSince: merges.length,
        }),
      }),
      null,
      NOW,
    );

    expect(hours.length).toBeGreaterThan(0);
    expect(new Set(hours)).toEqual(new Set([MERGED_STANDS_HOURS]));
    expect([...notes.matchAll(/(\d+) minutes?\b/g)]).toEqual([]);
    // The notes give No deploy seen's wait in words, as "an hour".
    expect(notes).toContain("within an hour of the merge");
    expect(NO_DEPLOY_SEEN_MINUTES).toBe(60);
    expect(mostRecent.length).toBeGreaterThan(0);
    expect(new Set(mostRecent)).toEqual(new Set([list?.entries.length]));
    expect(list?.leftOut).toBe(merges.length - (list?.entries.length ?? 0));
    expect(notes).toContain(`\`STANDING_SCHEMA\` stays ${STANDING_SCHEMA}`);
  });

  describe("name only what the code holds under that name", () => {
    const notes = readFileSync(join(KIT, NOTES), "utf8");
    /** Everything the notes write as code, each once. */
    const written = [...new Set([...notes.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))];
    /** The notes' bullet that opens with `lead` in bold, with the bullets under it. */
    const bullet = (lead: string): string => {
      const lines = notes.split("\n");
      const at = lines.findIndex((line) => line.startsWith(`- **${lead}`));
      return at === -1 ? "" : [lines[at], ...lines.slice(at + 1).filter((line, index, rest) => rest.slice(0, index + 1).every((under) => under.startsWith("  - ")))].join("\n");
    };
    /** Those of `names` that `text` does not write as code. */
    const missingFrom = (text: string, names: readonly string[]): string[] => names.filter((name) => !text.includes(`\`${name}\``));

    it("every export the release adds to the read library's entry, by the name the entry gives it", () => {
      const reader = section(notes, "What is new for a reader of the Kit");
      const exported = [...Object.keys(EXPORT_CALLS), ...Object.keys(EXPORT_SHAPES)];

      expect(NEW_EXPORTS.filter((name) => !exported.includes(name))).toEqual([]);
      expect(missingFrom(reader, NEW_EXPORTS)).toEqual([]);
      expect(reader).toContain("exported through the read library's entry, `src/read/index.ts`");
      expect(existsSync(join(KIT, "src/read/index.ts"))).toBe(true);
    });

    it("the new place and the three new Standing names, and the four that are said at Staging too", () => {
      const standing = bullet("The Standing.");

      expect(standing).toContain("`place` can be `staging`");
      expect(standing).toContain("`STANDING_NAMES` gains `on-staging`, `trial-accepted` and `trial-problem`");
      expect(missingFrom(standing, AT_STAGING)).toEqual([]);
      expect([...AT_STAGING, ...ALSO_YOURS].filter((name) => !(STANDING_NAMES as readonly string[]).includes(name))).toEqual([]);
      // Each new name is one a Standing at Staging has, in the fixture that holds one Standing of every name.
      expect(NEW_NAMES.map((name) => KEPT[name]?.place)).toEqual(NEW_NAMES.map(() => "staging"));
    });

    it("every key a merged pull request's Standing carries under detail.staging in a repo that declares staging", () => {
      const standing = bullet("The Standing.");
      const carried = Object.keys((KEPT["on-staging"]?.detail as { staging: object }).staging);

      expect(carried.toSorted()).toEqual([...STAGING_DETAIL].toSorted());
      expect(standing).toContain("carries `detail.staging`");
      expect(missingFrom(standing, [...STAGING_DETAIL, ...TRIAL, ...TRIAL_WHYS])).toEqual([]);
    });

    it("every key of a row's staging, of a staging read and of a Promote list, and each result an agent entry can have", () => {
      const list = EXPORT_SHAPES["PromoteList"] as PromoteList;
      const entries = EXPORT_SHAPES["PromoteEntry"] as readonly PromoteEntry[];
      const agent = entries.flatMap((entry) => (entry.is === "agent" ? [entry] : []));

      expect(Object.keys(list).toSorted()).toEqual([...PROMOTE_LIST].toSorted());
      expect(missingFrom(bullet("The Promote list.**"), [...PROMOTE_LIST, ...ENTRY, ...RESULTS, ...NOT_ON_STAGING])).toEqual([]);
      expect([...new Set(agent.map(({ result }) => result.is))].toSorted()).toEqual([...RESULTS].toSorted());
      expect(Object.keys(agent[0]?.staging ?? {}).toSorted()).toEqual([...ROW_STAGING].toSorted());
      expect(missingFrom(bullet("The rows."), [...ROW_STAGING, ...STAGING_READ, "rowsOf", "Row", "staging"])).toEqual([]);
      expect(Object.keys(EXPORT_SHAPES["StagingRead"] as StagingRead).toSorted()).toEqual([...STAGING_READ].toSorted());
      expect(missingFrom(bullet("The staging reads."), [...CHECK_STATES, ...UNREAD, ...NEWEST, "{ newest: true }"])).toEqual([]);
      expect(A_NEWEST_READ).toEqual({ newest: true });
    });

    it("the two labels by their names, and the Trial problem's line as its writer writes it", () => {
      expect(missingFrom(notes, [TRIAL_ACCEPTED_LABEL, TRIAL_PROBLEM_LABEL, trialProblemLine(50)])).toEqual([]);
      expect(trialProblemIn(`The cart total reads 0 on staging.\n\n${trialProblemLine(50)}`)).toBe(50);
    });

    it("the Kit config fields as Kit config takes them, in blocks that resolve as the notes write them", () => {
      const staging = JSON.parse(EXAMPLES.staging) as Record<string, unknown>;
      const declared = JSON.parse(`{ ${EXAMPLES.declared} }`) as Record<string, unknown>;
      const workflow = JSON.parse(`{ ${EXAMPLES.workflow} }`) as Record<string, unknown>;
      const file = { operator: "octo", ...declared, production: { url: "http://shop.example", environment: "production", ...workflow }, monitor: { red_main: true, main_checks: ["smoke"] } };
      const result = resolveKitConfig({ config: JSON.stringify(file) });

      expect(declared).toEqual({ staging });
      expect(workflow).toEqual({ workflow: JSON.parse(EXAMPLES.file) });
      expect(result).toMatchObject({ ok: true, config: { operator: "octo", staging, production: { ...file.production }, monitor: { redMain: true, mainChecks: ["smoke"] } } });
      // A workflow's file may end either way, and a field Kit config doesn't have is refused.
      expect(resolveKitConfig({ config: JSON.stringify({ ...file, production: { ...file.production, workflow: "deploy.yaml" } }) }).ok).toBe(true);
      expect(resolveKitConfig({ config: JSON.stringify({ ...file, staging: { ...staging, site: "syd1" } }) }).ok).toBe(false);
      expect(resolveKitConfig({ config: "{}" })).toMatchObject({ ok: true, config: { staging: null, production: null } });
      expect(missingFrom(notes, [...Object.values(EXAMPLES), ...CONFIG_FIELDS])).toEqual([]);
      expect(CONFIG_FIELDS.filter((path) => path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], file) === undefined)).toEqual([]);
    });

    it("and nothing else: everything they write as code is one of those, or an export the entry already had", () => {
      const held = new Set<string>([
        ...Object.keys(EXPORT_CALLS),
        ...Object.keys(EXPORT_SHAPES),
        ...STANDING_NAMES,
        ...[STAGING_DETAIL, TRIAL, TRIAL_WHYS, PROMOTE_LIST, ENTRY, RESULTS, NOT_ON_STAGING, ROW_STAGING, STAGING_READ, CHECK_STATES, UNREAD, NEWEST, STANDING, PLACES].flat(),
        ...[FACTS, KIT_CONFIG, CONFIG_FIELDS, Object.values(EXAMPLES), WRITTEN_IN_KIT_CONFIG].flat(),
        TRIAL_ACCEPTED_LABEL,
        TRIAL_PROBLEM_LABEL,
        trialProblemLine(50),
        "{ newest: true }",
        "detail.staging",
        "src/read/index.ts",
      ]);

      expect(written.filter((name) => !held.has(name))).toEqual([]);
    });
  });
});

/** One Standing of every name, as the Standing's fixture keeps them. */
const KEPT = JSON.parse(readFileSync(join(KIT, "src/__fixtures__/standings.json"), "utf8")) as Record<string, { readonly place: string | null; readonly detail: Record<string, unknown> }>;

/** These names, each one a key of `T`: the compiler holds a field the notes name to the type that has it. */
const keysOf =
  <T>() =>
  <const K extends readonly (keyof T & string)[]>(...names: K): K =>
    names;
/** These values, each one of `T`'s. */
const valuesOf =
  <T extends string>() =>
  <const V extends readonly T[]>(...values: V): V =>
    values;

type StagingDetail = NonNullable<Extract<Standing, { readonly name: "on-staging" }>["detail"]["staging"]>;
type AgentEntry = Extract<PromoteEntry, { readonly is: "agent" }>;
type NotOnStaging = Extract<AgentEntry["result"], { readonly is: "not-on-staging" }>;

/** What the release adds to the read library's entry. */
const NEW_EXPORTS = [
  "aStagingFacts",
  "aStagingRead",
  "aMainChecksRead",
  "readMainChecks",
  "joinStaging",
  "stagingMergesToRead",
  "commitsToCheck",
  "MainChecksRead",
  "MainCheckOf",
  "CommitToCheck",
  "StagingRead",
  "TRIAL_ACCEPTED_LABEL",
  "TRIAL_PROBLEM_LABEL",
  "trialProblemLine",
  "trialProblemIn",
  "promoteListOf",
  "PromoteList",
  "PromoteEntry",
];
const NEW_NAMES = valuesOf<Standing["name"]>()("on-staging", "trial-accepted", "trial-problem");
/** Every name a Standing at Staging can have. */
const AT_STAGING = [...NEW_NAMES, ...valuesOf<Standing["name"]>()("merged", "deploying", "deploy-failed", "no-deploy-seen")];
/** The names that were the Operator's without stopping work before this release. */
const ALSO_YOURS = valuesOf<Standing["name"]>()("yours-to-read", "parked");
const PLACES = valuesOf<NonNullable<Standing["place"]>>()("staging");
const STANDING = keysOf<Standing>()("place", "yours", "stopsWork");
const STAGING_DETAIL = keysOf<StagingDetail>()("environment", "production", "trial", "result", "standsUntil", "mainChecks", "check", "checksUnread");
const TRIAL = keysOf<StagingDetail["trial"]>()("needed", "why");
const TRIAL_WHYS = valuesOf<StagingDetail["trial"]["why"]>()("ui-evidence", "closes-trial-problem", "no-screen");
const ROW_STAGING = keysOf<NonNullable<Row["staging"]>>()("site", "pages", "shots", "toTry");
const STAGING_READ = keysOf<StagingRead>()("deployments", "mainChecks");
const NEWEST = keysOf<DeployOf>()("newest");
const A_NEWEST_READ = { newest: true } satisfies NonNullable<Parameters<typeof readDeployments>[5]>;
const CHECK_STATES = valuesOf<MainCheckOf["is"]>()("green", "red", "undecided");
const UNREAD = valuesOf<Extract<MainChecksRead["commits"][string], string>>()("unread");
const PROMOTE_LIST = keysOf<PromoteList>()("repo", "start", "entries", "notAccepted", "leftOut", "dispatchPage");
const ENTRY = [...keysOf<PromoteEntry>()("is"), ...keysOf<AgentEntry>()("result", "standing")];
const RESULTS = valuesOf<AgentEntry["result"]["is"]>()("untried", "accepted", "problem", "no-screen", "not-on-staging");
const NOT_ON_STAGING = keysOf<NotOnStaging>()("name", "unread");
const FACTS = keysOf<Facts>()("staging");
const KIT_CONFIG = keysOf<KitConfig>()("staging", "production", "operator");

/** The Kit config the notes write out, each as they write it. */
const EXAMPLES = {
  staging: '{ "url": "https://staging.shop.example", "environment": "staging" }',
  declared: '"staging": { "url": "https://staging.shop.example", "environment": "staging" }',
  workflow: '"workflow": "deploy.yml"',
  file: '"deploy.yml"',
} as const;
/** The Kit config fields the notes name by their path in the file. */
const CONFIG_FIELDS = ["staging", "staging.environment", "production", "production.environment", "production.workflow", "monitor.main_checks", "monitor.red_main", "operator"];
/** What else the notes write as Kit config has it: a field's name within its block, a default, and how an address or a workflow's file starts or ends. */
const WRITTEN_IN_KIT_CONFIG = ["url", "environment", "null", "http://", "https://", ".yml", ".yaml"];

/** The notes' `## heading` section, to the next `## ` heading; empty when there is none. */
function section(notes: string, heading: string): string {
  const start = notes.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const end = notes.indexOf("\n## ", start + 1);
  return notes.slice(start, end === -1 ? undefined : end);
}
