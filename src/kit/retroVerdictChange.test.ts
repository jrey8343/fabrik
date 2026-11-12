// A Verdict's change line is kept from the Retro too (#643): its evidence
// carries each sampled PR's Verdicts as the Fabrik App posted them, but for
// that line, which is hashes for Kit code and says nothing to an agent.
import { expect, it } from "vitest";
import { aRetroEvidenceInput } from "../__fixtures__/retroEvidence.ts";
import { type ChangeFingerprint, changeLine } from "../loop/changeFingerprint.ts";
import { verdictMarker } from "../loop/markers.ts";
import { aMergedPullRequest, aVerdictComment, factsOf } from "../read/builders.ts";
import { evidenceBundle } from "./retroEvidence.ts";

const CHANGE: ChangeFingerprint = { v: 1, all: "0123456789ab", product: "ba9876543210", files: { "src/cart.ts": "aaaaaaaaaaaa" } };

it("the Retro's sample carries a Verdict's body without its change line, and an earlier Verdict's as it is", () => {
  const head = "a".repeat(40);
  const marker = verdictMarker({ verdict: "pass", source: "reviewer", requestChanges: false, headSha: head });
  const earlier = aVerdictComment("execution-flaw", "c".repeat(40), "2026-11-01T00:00:00Z");
  const pass = aVerdictComment("pass", head, "2026-11-02T00:00:00Z", { body: [marker, changeLine(CHANGE), "## Verdict: Pass", "", "Looks right."].join("\n") });

  const { sample } = evidenceBundle(
    aRetroEvidenceInput({
      // #12 is in the sample.
      facts: factsOf({ pullRequests: [aMergedPullRequest("2026-11-03T00:00:00Z", { number: 12, ticket: 7, comments: [earlier, pass] })] }),
      tickets: [{ number: 7, title: "Build the cart", body: "A cart." }],
    }),
  );

  expect(sample[0]?.verdicts).toEqual([
    expect.objectContaining({ verdict: "execution-flaw", body: earlier.body }),
    { verdict: "pass", source: "reviewer", at: "2026-11-02T00:00:00Z", body: [marker, "## Verdict: Pass", "", "Looks right."].join("\n") },
  ]);
  expect(JSON.stringify(sample)).not.toContain("fabrik:change");
});
