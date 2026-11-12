// The glossary's Digest is the Kit's plain-English account of an agent pull
// request. A finished run's transcript cut down to fit a budget, which the
// Scorers' judge and the Retro read, went by the same word; it is the trimmed
// transcript. Nothing in the repo may call it a digest again, in words or in a
// name. The ADRs, the release notes of released versions, the research
// findings and the glossary are records, and tests may name the old use to
// check it's gone. The bare word is never matched: it is the glossary's.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRecord, KIT, repoFiles } from "../__fixtures__/repoScan.ts";

/**
 * What may stand between two words of the old use: one hyphen, a run of spaces
 * and Markdown emphasis, or a line break with a comment's leading `*`, `//` or
 * `#` after it. A list's next item, under a `-`, is not the same sentence.
 */
const BETWEEN = String.raw`(?:-|[ \t*_]+|[ \t*_]*\r?\n[ \t]*(?:\*|\/\/|#)?[ \t*_]*)`;

/**
 * The old use, as words and as names.
 * - "transcript digest", "transcript's digest", "transcript-digest" and their
 *   plurals, in any case, which takes in the names `transcriptDigest` and
 *   `TranscriptDigest`. A run's transcript artifact is named for its role, so
 *   `fabrik-transcript-digest` is a Digest run's and isn't the old use.
 * - "digest of the run's transcript", however the transcript is pointed at.
 * - The names the rename retired.
 */
const OLD_USE = [
  new RegExp(String.raw`(?<!fabrik-)transcript(?:s|['’]s|s['’])?${BETWEEN}?digests?`, "gi"),
  new RegExp(String.raw`digests?${BETWEEN}of${BETWEEN}(?:(?:the|a|an|its|each|every|that|this)${BETWEEN})?(?:[\w\`]+['’]s?${BETWEEN})?\`?transcripts?`, "gi"),
  /\b(?:digestOf|digestsOf|DigestLine|DIGEST_BUDGET|digestCutTo)\b/g,
  /(?<![A-Za-z])(?:Digested[A-Za-z]*|digested|undigested)\b/g,
];

/**
 * The score file's stored field, which keeps its name (src/kit/scorer.ts says
 * why), and the files that have to spell it: the score file's own module, the
 * score job's summary of one, and the fixture that builds one.
 */
const STORED_FIELD = /\bdigestTrimmed\b/g;
const HOLDS_THE_STORED_FIELD: ReadonlySet<string> = new Set(["src/kit/scorer.ts", "src/kit/scoreRecord.ts", "src/__fixtures__/weeklySummary.ts"]);

const isExempt = (path: string) => isRecord(path) || path.startsWith("docs/research/") || path === "GLOSSARY.md";

/** The lines of a file the old use starts on, as `path:line: text`. */
function oldUseIn(path: string, text: string): string[] {
  const lines = text.split("\n");
  const at = new Set<number>();
  const patterns = HOLDS_THE_STORED_FIELD.has(path) ? OLD_USE : [...OLD_USE, STORED_FIELD];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) at.add(text.slice(0, match.index).split("\n").length - 1);
  }
  return [...at].sort((a, b) => a - b).map((index) => `${path}:${index + 1}: ${(lines[index] ?? "").trim()}`);
}

describe("A run's cut-down transcript is the trimmed transcript, not a digest", () => {
  it("finds the old use as words, whatever the case or the number", () => {
    expect(oldUseIn("prompts/retro.md", "the last passing Review run on the PR with its transcript digest.")).toHaveLength(1);
    expect(oldUseIn("prompts/retro.md", "its Verdicts, Run records and transcript digests, so ordinary runs")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "/** A Run record with its transcript's digest. */")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "// the agent runs on its Ticket with their transcripts' digests")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "// The transcript digest (#149, #151): a finished run's transcript")).toHaveLength(1);
    expect(oldUseIn("README.md", "Transcript Digests are held to a budget.")).toHaveLength(1);
    expect(oldUseIn(".github/workflows/loop.yml", "# the transcript-digest step")).toHaveLength(1);
  });

  it("finds a digest of a transcript", () => {
    expect(oldUseIn("src/kit/scorerPrompt.ts", '"what the run\'s prompt carried beyond it, and a digest of the run\'s transcript come next"')).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "// a compact digest of the transcript")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "// The digest of `transcript` that the judge reads")).toHaveLength(1);
    expect(oldUseIn("README.md", "Digests of its transcripts are cut.")).toHaveLength(1);
  });

  it("finds the old use split over a line break", () => {
    expect(oldUseIn("src/kit/x.ts", "// Ticket (#450), and a compact digest of the run's\n// transcript, held to the judge's budget")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", " * The run's transcript read through the transcript\n * digest, as the judge reads it")).toHaveLength(1);
    expect(oldUseIn("README.md", "each with its **transcript**\ndigest")).toHaveLength(1);
  });

  it("names the line the old use starts on", () => {
    expect(oldUseIn("README.md", "one\ntwo, a transcript\ndigest")).toEqual(["README.md:2: two, a transcript"]);
  });

  it("finds each name the rename retired", () => {
    expect(oldUseIn("src/kit/x.ts", 'import { digestOf } from "./transcriptDigest.ts";')).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "export interface TranscriptDigest {")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "const { digest, trimmed } = digestOf(transcript)(budget);")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "const digests = digestsOf(input.readTranscript);")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "interface DigestLine {")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "export const DIGEST_BUDGET = 300_000;")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "readonly run: DigestedRecordEvidence | null;")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "type Digested = (record: RunRecord) => Evidence;")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "escapes: escapesOf(window, metrics, digested, ticketOf),")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "const undigested = (record) => record;")).toHaveLength(1);
    expect(oldUseIn("src/kit/x.ts", "function digestCutTo(record: RunRecord, whole: string) {")).toHaveLength(1);
  });

  it("finds the judge's files' old field, anywhere but where the score file's stored field is spelled", () => {
    const line = "  return `${JSON.stringify({ digestTrimmed, output }, null, 2)}\\n`;";
    expect(oldUseIn("src/kit/judge.ts", line)).toHaveLength(1);
    expect(oldUseIn("src/kit/judge-main.ts", "  let digestTrimmed: boolean | null = null;")).toHaveLength(1);
    expect(oldUseIn(".github/workflows/loop.yml", "jq .digestTrimmed result.json")).toHaveLength(1);

    expect(oldUseIn("src/kit/scorer.ts", "  readonly digestTrimmed: boolean | null;")).toEqual([]);
    expect(oldUseIn("src/kit/scoreRecord.ts", 'score.digestTrimmed === true ? " from a trimmed transcript" : ""')).toEqual([]);
    expect(oldUseIn("src/__fixtures__/weeklySummary.ts", "    digestTrimmed: false,")).toEqual([]);
  });

  it("still finds the other retired names in a file that spells the stored field", () => {
    expect(oldUseIn("src/kit/scorer.ts", "/** Whether the transcript's digest was trimmed. */")).toHaveLength(1);
  });

  it("leaves the trimmed transcript's own names", () => {
    const now = [
      'import { cutMarker, trimmedTranscriptOf } from "./trimmedTranscript.ts";',
      "export interface TrimmedTranscript {",
      "export const TRIMMED_TRANSCRIPT_BUDGET = 300_000;",
      "  return `${JSON.stringify({ transcriptTrimmed, output }, null, 2)}\\n`;",
      "      readonly trimmedTranscript: string | null;",
      "the last passing Review run on the PR with its trimmed transcript.",
    ];
    expect(oldUseIn("src/kit/x.ts", now.join("\n"))).toEqual([]);
  });

  it("leaves the glossary's Digest, Node's hashing call and every name the Digest goes by", () => {
    const digest = [
      "The Digest is the Kit's plain-English account of an agent pull request.",
      "A Digest run's transcript is kept beside its Run record.",
      "The Digest writer reads the pull request, not the run's transcript. Digest runs are never held.",
      "- its Run records and transcripts\n- Digest: the account the Operator reads",
      "Collapse older Digests, and the digest a carried one was copied from.",
      'const hash = createHash("sha256").update(key).digest("hex");',
      "const digest = createHash(\"sha256\").update(key).digest();",
      "Outputs are `artifact-id`, `artifact-url` and `artifact-digest`.",
      "          name: fabrik-transcript-digest",
      "labels: agent:digest",
      '<!-- fabrik:digest {"head":"abc","asks":[],"carriedFrom":null} -->',
      "<!-- fabrik:digest-folds -->",
      '<!-- fabrik:digest-data {"v":1} -->',
      '<!-- fabrik:no-digest {"head":"abc","how":"failed"} -->',
      "roles.digest.timeout_minutes, digest.enabled, .fabrik/digest.md, prompts/digest.md",
      "digest-run-finished, digest-timeout-minutes, fabrik-digest-12, DIGEST_JOB_NAME, DIGEST_LABEL, DIGEST_MARKER",
      "DIGEST_FOLDS_MARKER, DIGEST_DATA_MARKER, DIGEST_DATA_VERSION, NO_DIGEST_HOWS, NoDigestHow",
      "noDigestLine({ head, how }), noDigestIn(body), isDigestComment(body), readDigestComment(body)",
      "digestCommentOf(reply, given), digestMarker(mark), digestTop(data, where), digestOnPass(event)",
      "DigestReply, parseDigestReply(text), DigestGiven, readDigestGiven, DigestData, DigestRead, readDigestPlaces",
      "startDigestOnLabel, landDigest, leavingOutDigests, aDigestComment, aNoDigestLine, carry-digest",
      "src/loop/digest.ts, src/loop/digestContract.ts, src/github/digestGiven.ts, src/agent/digest.ts",
      "src/loop/digestFacts.ts, src/loop/digestPlaces.ts, src/loop/digestCarry.ts, src/read/digestRead.ts",
      "readonly digests: readonly { node: string; minimized: boolean; body: string; postedAt: string }[]",
      "digests: readonly number[]",
    ];
    for (const line of digest) expect(oldUseIn("src/loop/x.ts", line)).toEqual([]);
  });

  it("has nothing in the repo calling a transcript a digest, but the records", async () => {
    const found: string[] = [];
    for (const path of repoFiles().filter((file) => !isExempt(file))) {
      if (/transcript-?digest/i.test(path)) found.push(`${path}: the file's name`);
      found.push(...oldUseIn(path, await readFile(join(KIT, path), "utf8").catch(() => "")));
    }

    expect(found).toEqual([]);
  });
});
