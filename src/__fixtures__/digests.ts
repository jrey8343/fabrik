// What a Digest is rendered from, for tests: the Digest writer's reply, Kit
// code's facts, and what the push job hands the contract beside the reply
// (src/loop/digestContract.ts). A Ticket that widens any of the three adds
// its field here once, and every test that lands a Digest keeps its shape.
import type { DigestGiven, DigestReply } from "../loop/digestContract.ts";
import type { DigestFacts, ThreadRequestChanges } from "../loop/digestFacts.ts";

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
    asks: [],
    productCode: { kind: "unchanged" },
    ...overrides,
  };
}

/**
 * A Request changes of the Operator's on #50 of acme/shop, as a thread has
 * it: review `review`, given at `at`, still requesting changes, not deferred,
 * with a line of text and no line comment.
 */
export function aRequestChanges(review: number, at: string, overrides: Partial<ThreadRequestChanges> = {}): ThreadRequestChanges {
  return {
    review,
    at,
    dismissed: false,
    deferred: false,
    body: "Call it a basket.",
    url: `https://github.com/acme/shop/pull/50#pullrequestreview-${review}`,
    lineComments: [],
    ...overrides,
  };
}

/**
 * A reply as the Digest writer emits one, keeping its shape: it answers the
 * Ticket's one criterion as in the head, has nothing for the Operator's eyes
 * and shows no Follow-up.
 */
export function aDigestReply(overrides: Partial<DigestReply> = {}): DigestReply {
  return {
    asks: [{ id: "c1", criterion: "A shopper can save their basket from /basket.", answer: "in-head", where: "src/basket/save.test.ts", checkedBy: "test" }],
    items: [],
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
