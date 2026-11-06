// Small builders for the Retro evidence bundle's tests, beside the Weekly
// summary's record and GitHub-facts builders (./weeklySummary.ts) that the
// bundle's tests build its facts with: say only what a test cares about.
import type { RetroEvidenceInput } from "../kit/retroEvidence.ts";
import { factsOf } from "./weeklySummary.ts";

/**
 * What a Retro reads of `owner/product` for the window from the last Retro's
 * end, Saturday 2026-10-31 00:00 UTC, to this one's a week later: nothing,
 * unless a test says so.
 */
export function aRetroEvidenceInput(overrides: Partial<RetroEvidenceInput> = {}): RetroEvidenceInput {
  return {
    records: [],
    facts: factsOf(),
    operator: "operator",
    lastWindowEnd: "2026-10-31T00:00:00Z",
    windowEnd: "2026-11-07T00:00:00Z",
    ...overrides,
  };
}
