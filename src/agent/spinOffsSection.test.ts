// The points of the Operator's Request changes that the Kit opened as
// Spin-offs (#884), as every later run on the pull request is given them: a
// Review, a Retry, a Touch-up, a conflict-only run, the next Request-changes
// run and the Digest writer.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verdictMarker } from "../loop/markers.ts";
import { digestContext } from "./digest.ts";
import { conflictContext, requestChangesContext, retryContext } from "./implement.ts";
import { OPERATOR_COMMENTS_HEADING, REQUESTED_CHANGES_HEADING, SPIN_OFFS_HEADING, spinOffsSection } from "./operatorComments.ts";
import { reviewContext } from "./review.ts";

const csv = {
  issue: 57,
  title: "Export the waitlist as CSV",
  from: "inline-9",
  url: "https://github.com/acme/shop/pull/50#discussion_r9",
  words: "Open the CSV export as its own issue.\nIt isn't part of this.",
};
const sms = { issue: 58, title: "Text the waitlist", from: "review-8", url: "https://github.com/acme/shop/pull/50#pullrequestreview-8", words: "Rename the total. Reminders by SMS in a different ticket." };

const requested = {
  id: "review-8",
  url: sms.url,
  submittedAt: "2026-11-05T00:00:00Z",
  body: sms.words,
  comments: [{ id: "inline-9", url: csv.url, path: "src/waitlist.ts", line: 4, body: csv.words }],
};

const pullRequest = {
  number: 50,
  title: "Add a waitlist",
  body: "Adds the waitlist.\n\nCloses #7",
  baseRefName: "main",
  headRefName: "fabrik/ticket-7",
  headRefOid: "a".repeat(40),
  comments: [{ body: `${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) })}\n- The total is misnamed.`, author: { __typename: "Bot" } }],
  operatorComments: [],
  requestedChanges: [requested],
  spinOffs: [csv, sms],
};

async function filesOf(value: unknown): Promise<{ dir: string; pullRequestFile: string; specFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-spin-offs-"));
  await writeFile(join(dir, "pull-request.json"), JSON.stringify(value));
  await writeFile(join(dir, "spec.json"), "null");
  return { dir, pullRequestFile: join(dir, "pull-request.json"), specFile: join(dir, "spec.json") };
}

const SECTION = [
  `## ${SPIN_OFFS_HEADING}`,
  "Points of the Operator's Request changes above that the Operator asked, in words, to be issues of their own. A Request-changes run left each unbuilt, and the Kit opened it as the issue that heads it here, so it is no part of this pull request's work. Under each are the Operator's words it came from. Weigh them as this prompt says.",
  "### #57: Export the waitlist as CSV",
  "Set aside from `inline-9`, where the Operator wrote:",
  "> Open the CSV export as its own issue.\n> It isn't part of this.",
  "### #58: Text the waitlist",
  "Set aside from `review-8`, where the Operator wrote:",
  "> Rename the total. Reminders by SMS in a different ticket.",
];

describe("The points set aside as Spin-offs, as a run's prompt sets them out (#884)", () => {
  it("heads each by its issue, with what asked for it and the Operator's words there, quoted", () => {
    expect(spinOffsSection([csv, sms])).toEqual(SECTION);
  });

  it("is nothing when the Kit opened none, so the prompt of any other pull request is as it always was", () => {
    expect(spinOffsSection([])).toEqual([]);
    expect(spinOffsSection(undefined)).toEqual([]);
  });

  it("reaches a Review after the Request changes it came from and before the Operator's comments, and not again inside the pull request's JSON", async () => {
    const { dir, pullRequestFile, specFile } = await filesOf(pullRequest);

    const text = (await reviewContext(dir, pullRequestFile, specFile)).parts.join("\n");

    expect(text).toContain(SECTION.join("\n"));
    expect(text.indexOf(`## ${SPIN_OFFS_HEADING}`)).toBeGreaterThan(text.indexOf(`## ${REQUESTED_CHANGES_HEADING}`));
    expect(text.indexOf(`## ${SPIN_OFFS_HEADING}`)).toBeLessThan(text.indexOf(`## ${OPERATOR_COMMENTS_HEADING}`));
    expect(text.split("Export the waitlist as CSV")).toHaveLength(2);
  });

  it("reaches a Retry and a Touch-up, which read the same input", async () => {
    const { pullRequestFile } = await filesOf(pullRequest);

    expect((await retryContext(pullRequestFile)).parts.join("\n")).toContain(SECTION.join("\n"));
  });

  it("reaches a conflict-only run", async () => {
    const { pullRequestFile } = await filesOf(pullRequest);

    expect((await conflictContext(pullRequestFile, "9".repeat(40))).parts.join("\n")).toContain(SECTION.join("\n"));
  });

  it("reaches the next Request-changes run, after the earlier Request changes they came from", async () => {
    const latest = { ...requested, id: "review-12", submittedAt: "2026-11-09T00:00:00Z", body: "Now rename the button.", comments: [] };
    const { dir, pullRequestFile } = await filesOf({ ...pullRequest, requestedChanges: [requested, latest] });
    const reviewFile = join(dir, "review.json");
    await writeFile(reviewFile, JSON.stringify({ review: { id: 12, state: "CHANGES_REQUESTED", body: latest.body }, comments: [] }));

    const text = (await requestChangesContext(pullRequestFile, reviewFile)).parts.join("\n");

    expect(text).toContain(SECTION.join("\n"));
    expect(text.indexOf(`## ${SPIN_OFFS_HEADING}`)).toBeGreaterThan(text.indexOf("### `review-8`: Request changes"));
    expect(text.indexOf(`## ${SPIN_OFFS_HEADING}`)).toBeLessThan(text.indexOf(`## ${OPERATOR_COMMENTS_HEADING}`));
  });

  it("reaches the Digest writer, as the Reviewer is given them", async () => {
    const { dir, pullRequestFile, specFile } = await filesOf({ ...pullRequest, verdicts: [], kitNotes: [], uiEvidence: false, capturedRoutes: [], facts: { asks: [] } });

    expect((await digestContext(dir, pullRequestFile, specFile, "a".repeat(40))).parts.join("\n")).toContain(SECTION.join("\n"));
  });
});
