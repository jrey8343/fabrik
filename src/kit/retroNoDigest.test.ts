// No agent run is given a Digest (ADR-0022), the Retro included. Its evidence
// leaves out every Run record in role `digest` with its transcript, which
// holds the Digest, as it leaves out a judge's run; and of a pull request's
// thread it carries only Verdicts and the Operator's words, so a Digest
// comment and a no-Digest line are in none of it.
import { describe, expect, it } from "vitest";
import { aDigestGiven, aDigestReply } from "../__fixtures__/digests.ts";
import { aRecordWithTranscript, aRetroEvidenceInput, aTranscript, transcriptsOf } from "../__fixtures__/retroEvidence.ts";
import { digestCommentOf, noDigestLine } from "../loop/digestContract.ts";
import { aComment, aMergedPullRequest, anEscapeMarkerIssue, aVerdictComment, factsOf } from "../read/builders.ts";
import { type EvidenceBundle, evidenceBundle, refsOf, retroEvidenceOf } from "./retroEvidence.ts";

const HEAD = "a".repeat(40);
const RUN = "https://github.com/owner/product/actions/runs/1002/attempts/1";

const REPLY = aDigestReply({ whatItDoes: "A shopper can now save their basket overnight.", decided: "- Prices hold for a day." });
const rendered = digestCommentOf(REPLY, aDigestGiven({ repoUrl: "https://github.com/owner/product", pullRequest: 12, headSha: HEAD, runUrl: RUN }));
if (!rendered.ok) throw new Error(`the fixture reply was refused: ${rendered.refused}`);

/** What only a Digest, a no-Digest line or a Digest run's transcript says. */
const OF_A_DIGEST = ["fabrik:digest", "fabrik:no-digest", "save their basket overnight", "Prices hold for a day", "No Digest could be written"];

const implement = aRecordWithTranscript({ runId: 1000, issue: 7, pullRequest: 12, endedAt: "2026-11-01T00:00:00Z" });
const review = aRecordWithTranscript({ runId: 1001, role: "review", issue: 7, pullRequest: 12, verdict: "pass", endedAt: "2026-11-02T00:00:00Z" });
/** The Digest run on #12, whose transcript holds the Digest it wrote. */
const digest = aRecordWithTranscript({ runId: 1002, role: "digest", issue: 7, pullRequest: 12, endedAt: "2026-11-02T00:05:00Z" });
const worked = aTranscript({ "src/cart.ts": "export const cart = [];" });
const wrote = aTranscript({ "src/cart.ts": JSON.stringify(REPLY) });

/** The evidence for a week in which #12, for Ticket 7, merged with a Digest and a no-Digest line on its thread: it is in the sample, and an escape names it. */
function bundle(): EvidenceBundle {
  return evidenceBundle(
    aRetroEvidenceInput({
      records: [implement, review, digest],
      readTranscript: transcriptsOf([implement, worked], [review, worked], [digest, wrote]),
      facts: factsOf({
        pullRequests: [
          aMergedPullRequest("2026-11-03T00:00:00Z", {
            number: 12,
            ticket: 7,
            comments: [
              aVerdictComment("pass", HEAD, "2026-11-02T00:00:00Z"),
              aComment(rendered.ok ? rendered.body : "", "2026-11-02T00:05:00Z"),
              aComment(noDigestLine({ head: HEAD, how: "timed-out", runUrl: RUN }), "2026-11-02T00:06:00Z"),
              aComment("Please rename this.", "2026-11-02T02:00:00Z", { author: "operator", byBot: false }),
            ],
          }),
        ],
        escapeMarkerIssues: [anEscapeMarkerIssue("<!-- fabrik:escape strong #12 -->")],
      }),
      tickets: [{ number: 7, title: "Build the cart", body: "A cart that totals its lines." }],
    }),
  );
}

describe("The Retro's evidence for a Ticket with a Digest run", () => {
  it("holds no Run record in role digest, among a sampled PR's runs or an escaped PR's, and the Ticket's other runs as before", () => {
    const { sample, escapes } = bundle();

    expect(sample.map(({ number, records }) => [number, records.map(({ record }) => record.role)])).toEqual([[12, ["implement", "review"]]]);
    expect(escapes.flatMap(({ pullRequests }) => pullRequests.map(({ number, records }) => [number, records.map(({ record }) => record.role)]))).toEqual([
      [12, ["implement", "review"]],
    ]);
  });

  it("holds no transcript of one, and no ref a proposal could cite it by", () => {
    const evidence = bundle();

    expect(sample(evidence).map(({ trimmedTranscript }) => trimmedTranscript !== null)).toEqual([true, true]);
    expect(refsOf(evidence).filter(({ ref }) => ref.includes("digest"))).toEqual([]);
    expect(Object.values(retroEvidenceOf(evidence).transcripts)).toEqual([implement.transcript, review.transcript]);
  });

  it("carries neither the Digest nor the no-Digest line on the pull request's thread, nor a word of the Digest run's transcript", () => {
    const text = JSON.stringify(bundle());

    expect(OF_A_DIGEST.filter((words) => text.includes(words))).toEqual([]);
    // The Operator's own words on the thread are still its feedback.
    expect(text).toContain("Please rename this.");
  });
});

function sample(evidence: EvidenceBundle): EvidenceBundle["sample"][number]["records"] {
  return evidence.sample.flatMap(({ records }) => records);
}
