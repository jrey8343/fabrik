// The notes for the release that ships the Digest are drafted ahead, beside
// the others (#657). While they are a draft they must say what the code does:
// the figures, the names and the Kit's own words they give are the ones the
// code holds. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { DIGEST_JOB_NAME } from "../github/snapshot.ts";
import { carriedDigest } from "../loop/digestCarry.ts";
import { digestCommentOf, MAX_ITEMS, MAX_TOP_WORDS, NO_DIGEST_HOWS, noDigestLine } from "../loop/digestContract.ts";
import { DIGEST_LABEL, LOOP_LABELS } from "../loop/labels.ts";
import { STUCK_TRIGGER_MINUTES } from "../loop/recoveryWaits.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "./config.ts";
import type { Standing } from "./standing.ts";
import { wordStanding } from "./standingWording.ts";

const NOTES = "docs/release-notes/digest.md";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Digest's release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them last among the drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: The Digest");
    expect(notes).toMatch(/^The notes for the release that ships the Digest /m);
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("[the production minor's](release-notes/production.md) and [the Digest minor's](release-notes/digest.md).");
  });

  it("say what the Operator sees at the Merge gate as the contract renders it: the top's four sections and the four folds, each by its name, in order", async () => {
    const notes = await read(NOTES);
    const digest = digestCommentOf(aDigestReply(), aDigestGiven());
    const body = digest.ok ? digest.body : "";
    const sections = [...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    const folds = [...body.matchAll(/^<summary>(.+)<\/summary>$/gm)].map((match) => match[1]);

    expect(sections).toHaveLength(4);
    expect(folds).toHaveLength(4);
    const at = [...sections, ...folds].map((name) => notes.indexOf(`- **${name}**: `));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
    expect(notes).toContain("a comment of its own");
    expect(notes).toContain("as of one head");
  });

  it("say how the wait shows: the label, the run's title on the Actions tab as the unchanged caller names it, and the job's name", async () => {
    const notes = await read(NOTES);
    const caller = await read("templates/fabrik.yml");

    expect(DIGEST_LABEL).toBe("agent:digest");
    expect(caller).toContain("github.event.action == 'labeled' && format('PR #{0} labeled {1}', github.event.pull_request.number, github.event.label.name)");
    expect(caller).not.toContain(DIGEST_LABEL);
    expect(notes).toContain('"PR #<number> labeled agent:digest"');
    expect(notes).toContain(`"${DIGEST_JOB_NAME} PR #<number>"`);
    expect(notes).toContain("holds its `max_in_flight` slot");
  });

  it("say the gate never waits on a Digest's success, with the no-Digest line's own words and every way an attempt ends with none", async () => {
    const notes = await read(NOTES);
    const said = "No Digest could be written for this head";

    expect(noDigestLine({ head: "a".repeat(40), how: "failed" })).toContain(said);
    expect(notes).toContain(`"${said}"`);
    expect(notes).toContain("never waits on a Digest's success");
    for (const how of NO_DIGEST_HOWS) expect(notes).toContain(`\`${how}\``);
  });

  it("give only the figures the code holds: the attempt's 10 minutes, the 30 a lost start waits, the top's 180 words", async () => {
    const notes = await read(NOTES);
    const minutes = [...notes.matchAll(/(\d+) minutes?\b/g)].map((match) => Number(match[1]));
    const words = [...notes.matchAll(/(\d+) words?\b/g)].map((match) => Number(match[1]));

    expect(new Set(minutes)).toEqual(new Set([DEFAULT_KIT_CONFIG.roles.digest.timeoutMinutes, STUCK_TRIGGER_MINUTES]));
    expect(new Set(minutes).size).toBe(2);
    expect(new Set(words)).toEqual(new Set([MAX_TOP_WORDS]));
    expect(notes).toContain("at most four items");
    expect(MAX_ITEMS).toBe(4);
    expect([...notes.matchAll(/(\d+) (?:hours?|days?)\b/g)]).toEqual([]);
  });

  it("give the trial's figures as a trial's, measured on a laptop and not through the Kit", async () => {
    const notes = await read(NOTES);
    const figured = notes.split("\n").filter((line) => /\$\d|\d+ (?:to \d+ )?seconds\b/.test(line));

    expect(figured.join("\n")).toContain("20 to 75 seconds");
    expect(figured.join("\n")).toContain("$0.11 to $0.47");
    for (const line of figured) expect(line).toMatch(/\btrial\b/);
    const spend = notes.split("\n").find((line) => line.includes("$0.11 to $0.47")) ?? "";
    expect(spend).toContain("on a laptop");
    expect(spend).toContain("not through the Kit");
    expect(spend).toContain("No Scorer judges");
  });

  it("name the two Kit config additions with their defaults, how to turn the Digest off, and the label as GitHub and Setup make it", async () => {
    const notes = await read(NOTES);
    const starter = JSON.parse(await read("templates/fabrik-config.json")) as { roles: Record<string, unknown>; digest: unknown };
    const resolved = resolveKitConfig({ config: JSON.stringify({ roles: { review: { model: "claude-sonnet-5-5", effort: "high" } } }) });
    if (!resolved.ok) throw new Error("expected a Kit config");
    const { roles, digest } = resolved.config;

    // The defaults the notes give are the ones a Kit config that names neither gets.
    expect({ model: roles.digest.model, effort: roles.digest.effort }).toEqual({ model: roles.review.model, effort: roles.review.effort });
    expect(roles.digest.timeoutMinutes).toBe(10);
    expect(digest.enabled).toBe(true);
    expect(starter.roles).toHaveProperty("digest");
    expect(starter.digest).toEqual({ enabled: true });

    expect(notes).toContain("- **Kit config:** two additions, each with a default");
    expect(notes).toContain("`roles.digest` sets the Digest writer's `model`, `effort` and `timeout_minutes`");
    expect(notes).toContain("its model and effort are the repo's own `roles.review`");
    expect(notes).toContain("`digest.enabled` is the Digest's switch, `true` by default");
    expect(notes).toContain("**To turn it off** in a Product repo, set `digest.enabled` to `false`");

    // Setup would colour and describe the label, where it is the one to create it.
    expect(LOOP_LABELS[DIGEST_LABEL].description).not.toBe("");
    const label = notes.split("\n").find((line) => line.startsWith("- **The label:** `agent:digest`")) ?? "";
    expect(label).toContain("with a pass on its current head");
    expect(label).toContain("plain, with no colour or description of the Kit's");
    expect(label).toContain("Setup creates only a label that is missing");
  });

  it("say the rest of what changed in the Kit's own words: a carried Digest's line, the comparison that could not be established, and the waiting draft's Standing", async () => {
    const notes = await read(NOTES);
    const prompt = await read("prompts/digest.md");
    const carried = carriedDigest(digestBodyOf(), { repoUrl: "https://github.com/acme/shop", pullRequest: 50, headSha: "b".repeat(40) }, { files: [], changed: [] });
    const waiting = { name: "running", pullRequest: 12, since: "2026-11-13T00:00:00Z", detail: { run: "digest", retry: null, actionsRun: 1, passed: true } } as unknown as Standing;

    expect(carried).toContain("Carried over from `aaaaaaa` because only `main` moved.");
    expect(notes).toContain('"Carried over from" the head it was written at, "because only `main` moved."');
    expect(notes).toContain("no model runs");
    expect(notes).toContain("collapsed as outdated");
    expect(prompt).toContain('say it "could not be established"');
    expect(notes).toContain('"could not be established"');
    expect(notes).toContain("as a hidden line");
    expect(notes).toContain(`"${wordStanding(waiting, "2026-11-13T00:05:00Z", "UTC").sentence}"`);
  });

  it("say what the Operator's Request changes does during the wait, that no agent run is given a Digest, what a reader of the Kit gets and which word changed", async () => {
    const notes = await read(NOTES);
    const bullets = notes.split("\n").filter((line) => line.startsWith("- **"));
    const bullet = (opening: string): string => bullets.find((line) => line.startsWith(`- **${opening}`)) ?? "";

    expect(bullet("A Request changes on a passed draft**")).toContain("is acted on at once");
    expect(bullet("No agent run is given a Digest,**")).toContain("nothing in the Loop moves because of what one says");
    expect(bullet("For a reader of the Kit:**")).toContain("`readDigestPlaces`");
    expect(Object.keys(await import("../read/index.ts"))).toContain("readDigestPlaces");
    expect(bullet("A word changed:**")).toContain("the trimmed transcript");
    expect(bullet("A word changed:**")).toContain("One stored score-file field keeps its old name");
  });
});

/** A Digest's comment, as the contract renders the fixture reply at head `a…a`. */
function digestBodyOf(): string {
  const digest = digestCommentOf(aDigestReply(), aDigestGiven());
  if (!digest.ok) throw new Error("expected a Digest");
  return digest.body;
}
