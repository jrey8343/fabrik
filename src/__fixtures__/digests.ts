// What a Digest is rendered from, for tests: the Digest writer's reply, Kit
// code's facts, and what the push job hands the contract beside the reply
// (src/loop/digestContract.ts). A Ticket that widens any of the three adds
// its field here once, and every test that lands a Digest keeps its shape.
import type { DigestGiven, DigestReply } from "../loop/digestContract.ts";
import type { DigestFacts } from "../loop/digestFacts.ts";

const HEAD = "a".repeat(40);

/**
 * Kit code's facts for a pull request whose first run the Reviewer passed:
 * two rounds, both Retries left, no Follow-up, and the product code
 * unchanged since that first Verdict, which is the pass.
 */
export function aDigestFacts(overrides: Partial<DigestFacts> = {}): DigestFacts {
  return {
    rounds: [
      { who: "implementer", what: "first-run", effect: null },
      { who: "reviewer", what: "pass", effect: null },
    ],
    counts: { passes: 1, executionFlaws: 0, designFlaws: 0, retries: 0, conflictOnlyRuns: 0, requestChanges: 0, infrastructureFailures: 0 },
    retriesLeft: 2,
    followUps: [],
    productCode: { kind: "unchanged" },
    ...overrides,
  };
}

/** A reply as the Digest writer emits one, keeping its shape: it shows no Follow-up. */
export function aDigestReply(overrides: Partial<DigestReply> = {}): DigestReply {
  return {
    whatItDoes: "A shopper can now save their basket from /basket. A saved basket keeps its prices for a day.",
    howItGotHere: "One Review passed it at the first head. The product code is unchanged since that Verdict.",
    followUps: [],
    walkthrough: ["```", "on save:", "  store the lines", "  store the prices shown", "```", "", "1. The basket page's Save button.", "2. The saved-basket rule."].join("\n"),
    decided: "- **Decided:** prices hold for a day; the Ticket did not say.\n- **Left alone:** sharing a saved basket by link.",
    roundsLine: "One Review, which passed it.",
    ...overrides,
  };
}

/** What the push job hands the contract for the Digest of #50 of acme/shop at head `a…a`, with aDigestFacts for its facts. */
export function aDigestGiven(overrides: Partial<DigestGiven> = {}): DigestGiven {
  return {
    repoUrl: "https://github.com/acme/shop",
    pullRequest: 50,
    headSha: HEAD,
    runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
    facts: aDigestFacts(),
    ...overrides,
  };
}
