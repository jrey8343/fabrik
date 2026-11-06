import { describe, expect, it } from "vitest";
import {
  aPullRequest,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  snapshotOfPullRequest,
  verdictsPostedIn,
} from "../__fixtures__/snapshots.ts";
import { MAX_ISSUE_URL_LENGTH } from "./followUps.ts";
import { planFor } from "./rules.ts";
import type { Action, LoopEvent, Plan } from "./types.ts";

const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";

function redChecks(overrides: Partial<Extract<LoopEvent, { kind: "required-checks-finished" }>> = {}): LoopEvent {
  return { kind: "required-checks-finished", pullRequest: 50, headSha: HEAD_SHA, failed: ["build"], runUrl: RUN, ...overrides };
}

function reviewed(output: string, overrides: Partial<Extract<LoopEvent, { kind: "review-run-finished" }>> = {}): LoopEvent {
  return { kind: "review-run-finished", pullRequest: 50, headSha: HEAD_SHA, output, runUrl: RUN, repoUrl: "https://github.com/acme/shop", ...overrides };
}

function actionsOf(plan: Plan): readonly Action[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

function commentsOf(plan: Plan): string[] {
  return actionsOf(plan).flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

describe("Review: starting one", () => {
  it("a push to an agent draft PR starts a Review on the Reviewer's model and timeout", () => {
    const config = kitConfig();
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(aPullRequest()), config);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "start-agent-run",
          role: "review",
          issue: 50,
          model: config.roles.review.model,
          effort: config.roles.review.effort,
          timeoutMinutes: 30,
          subscription: "Claude token",
        },
      ],
    });
  });

  it("agent:review added to an agent draft PR starts a Review again", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "agent:review" },
      snapshotOfPullRequest(aPullRequest({ labels: ["agent:review"] })),
      kitConfig(),
    );

    expect(actionsOf(plan)).toMatchObject([{ kind: "start-agent-run", role: "review", issue: 50 }]);
  });

  it("any other label on a PR does nothing", () => {
    const plan = planFor(
      { kind: "pull-request-labeled", pullRequest: 50, label: "enhancement" },
      snapshotOfPullRequest(aPullRequest()),
      kitConfig(),
    );

    expect(plan.kind).toBe("nothing");
  });

  it.each([
    ["a person's PR", aPullRequest({ isAgent: false })],
    ["a closed agent PR", aPullRequest({ open: false })],
    ["an agent PR out of draft", aPullRequest({ draft: false })],
    ["an agent PR whose branch names no Ticket", aPullRequest({ ticket: null })],
  ])("a push to %s starts no Review", (_, pullRequest) => {
    const plan = planFor({ kind: "pull-request-pushed", pullRequest: 50 }, snapshotOfPullRequest(pullRequest), kitConfig());

    expect(plan.kind).toBe("nothing");
  });
});

describe("Review: a stale Verdict", () => {
  it.each([
    ["the PR has moved to a newer commit", aPullRequest({ headSha: "b".repeat(40) })],
    ["the PR already has a Verdict on that commit", aPullRequest({
      verdicts: [{ verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: HEAD_SHA }],
    })],
    ["the PR has left draft", aPullRequest({ draft: false })],
    ["the PR is closed", aPullRequest({ open: false })],
  ])("isn't posted when %s", (_, pullRequest) => {
    expect(planFor(reviewed("verdict: pass"), snapshotOfPullRequest(pullRequest), kitConfig()).kind).toBe("nothing");
    expect(planFor(redChecks(), snapshotOfPullRequest(pullRequest), kitConfig()).kind).toBe("nothing");
  });
});

describe("Review: the Verdict marker", () => {
  it("records a Verdict after a Request-changes run as one", () => {
    const plan = planFor(
      reviewed("verdict: execution-flaw\n\nStill broken."),
      snapshotOfPullRequest(aPullRequest({ requestChangesRun: true })),
      kitConfig(),
    );

    expect(verdictsPostedIn(commentsOf(plan))).toEqual([
      { verdict: "execution-flaw", source: "reviewer", requestChanges: true, headSha: HEAD_SHA },
    ]);
  });

  it("takes agent:review off the PR, so re-adding it starts a Review again", () => {
    const plan = planFor(
      reviewed("verdict: design-flaw\n\nWrong approach."),
      snapshotOfPullRequest(aPullRequest({ labels: ["agent:review"] })),
      kitConfig(),
    );

    expect(actionsOf(plan)[0]).toEqual({ kind: "remove-label", issue: 50, label: "agent:review" });
  });

});

describe("Review: red CI", () => {
  it("red required checks yield an Execution-flaw Verdict comment from CI, and no Reviewer run", () => {
    const plan = planFor(redChecks({ failed: ["build", "test"] }), snapshotOfPullRequest(aPullRequest()), kitConfig());

    const actions = actionsOf(plan);
    expect(actions.filter((action) => action.kind === "start-agent-run")).toEqual([]);
    expect(actions.map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    const [body] = commentsOf(plan);
    expect(actions[0]).toMatchObject({ kind: "comment", issue: 50 });
    expect(verdictsPostedIn([body!])).toEqual([
      { verdict: "execution-flaw", source: "ci", requestChanges: false, headSha: HEAD_SHA },
    ]);
    expect(body).toContain("`build`");
    expect(body).toContain("`test`");
    expect(notificationsOf(plan)).toEqual([]);
    expect(body).toContain(`[The run](${RUN})`);
  });
});

describe("Review: the Reviewer's Verdict", () => {
  it.each([
    ["verdict: execution-flaw\n\nThe empty-cart case throws.", "execution-flaw", "The empty-cart case throws."],
    ["verdict: design-flaw\n\nThe Ticket asks for two contradictory things.", "design-flaw", "The Ticket asks for two contradictory things."],
    ["verdict: pass\n\nLooks good.", "pass", "Looks good."],
  ])("the Verdict line in %j is posted as a %s Verdict from the Reviewer", (output, verdict, findings) => {
    const plan = planFor(reviewed(output), snapshotOfPullRequest(aPullRequest()), kitConfig());

    const [body] = commentsOf(plan);
    expect(verdictsPostedIn([body!])).toEqual([{ verdict, source: "reviewer", requestChanges: false, headSha: HEAD_SHA }]);
    expect(body).toContain(findings);
    expect(body).toContain(`[The run](${RUN})`);
  });

  it("a pass takes the PR out of draft and requests the Operator's review, its only notification", () => {
    const plan = planFor(
      reviewed("verdict: pass\n\nLooks good, @someone."),
      snapshotOfPullRequest(aPullRequest(), { operator: "jrey" }),
      kitConfig(),
    );

    expect(actionsOf(plan).filter((action) => action.kind !== "comment")).toEqual([
      { kind: "mark-ready-for-review", pullRequest: 50 },
      { kind: "request-review", pullRequest: 50, reviewer: "jrey" },
    ]);
    expect(notificationsOf(plan, "jrey")).toEqual(["review request on #50"]);
    // The Reviewer's findings mention nobody.
    expect(commentsOf(plan)[0]).not.toMatch(/@someone/);
  });

  it("an Execution-flaw Verdict is posted and starts a retry: it doesn't leave draft or notify anyone", () => {
    const plan = planFor(reviewed("verdict: execution-flaw\n\nFix the build."), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    expect(notificationsOf(plan)).toEqual([]);
  });

  it.each([
    ["an empty reply", ""],
    ["a reply of only whitespace", "  \n\n "],
    ["a reply with no Verdict line", "The PR looks fine to me."],
    ["a Verdict line that isn't first", "Here is my review.\nverdict: pass"],
    ["an unknown verdict", "verdict: approve\n\nShip it."],
    ["a capitalised Verdict line", "Verdict: pass"],
    ["a Verdict line with more after it", "verdict: pass, mostly\n\nOne nit."],
    ["two verdicts on the line", "verdict: pass verdict: design-flaw"],
  ])("%s is an Infrastructure failure, never a pass", (_, output) => {
    const plan = planFor(reviewed(output), snapshotOfPullRequest(aPullRequest()), kitConfig());

    expect(plan).toMatchObject({ kind: "fail", failure: "infrastructure" });
  });
});

describe("Review: the Operator comments the Reviewer weighed", () => {
  const given = [
    { id: "conversation-3", url: "https://github.com/acme/shop/pull/50#issuecomment-3" },
    { id: "inline-9", url: "https://github.com/acme/shop/pull/50#discussion_r9" },
  ];

  it("the Verdict ends with an Operator comments considered section, one link per comment, from what the run was given", () => {
    const plan = planFor(
      reviewed("verdict: pass\n\nThe parking copy matches the Operator's answer.\n\noperator comments considered: conversation-3, inline-9", {
        operatorComments: given,
      }),
      snapshotOfPullRequest(aPullRequest()),
      kitConfig(),
    );

    const body = commentsOf(plan)[0] ?? "";
    expect(body).toMatch(
      /\n\n### Operator comments considered\n\n- \[`conversation-3`\]\(https:\/\/github\.com\/acme\/shop\/pull\/50#issuecomment-3\)\n- \[`inline-9`\]\(https:\/\/github\.com\/acme\/shop\/pull\/50#discussion_r9\)$/,
    );
    // The line naming them is the Kit's to render, not part of the findings.
    expect(body).not.toContain("operator comments considered:");
    expect(body).toContain("The parking copy matches the Operator's answer.");
  });

  it("an id the run wasn't given never becomes a link, and the Verdict still lands", () => {
    const plan = planFor(
      reviewed("verdict: execution-flaw\n\nFix the build.\n\noperator comments considered: conversation-3, conversation-404", {
        operatorComments: given,
      }),
      snapshotOfPullRequest(aPullRequest()),
      kitConfig(),
    );

    const body = commentsOf(plan)[0] ?? "";
    expect(actionsOf(plan).map((action) => action.kind)).toEqual(["comment", "add-labels"]);
    expect(body).toContain("- [`conversation-3`](https://github.com/acme/shop/pull/50#issuecomment-3)");
    expect(body).not.toContain("conversation-404");
    expect(body).not.toContain("inline-9");
  });

  it.each([
    ["names none", "verdict: pass\n\nLooks right.", given],
    ["names only ids it wasn't given", "verdict: pass\n\nLooks right.\n\noperator comments considered: review-1", given],
    ["names a comment but was given none", "verdict: pass\n\nLooks right.\n\noperator comments considered: conversation-3", undefined],
  ])("a Verdict whose Reviewer %s leaves the section out", (_, output, operatorComments) => {
    const plan = planFor(
      reviewed(output, operatorComments === undefined ? {} : { operatorComments }),
      snapshotOfPullRequest(aPullRequest()),
      kitConfig(),
    );

    const body = commentsOf(plan)[0] ?? "";
    expect(body).not.toContain("Operator comments considered");
    expect(body).toMatch(/\[The run\]\(https:\/\/github\.com\/acme\/shop\/actions\/runs\/42\/attempts\/1\)$/);
  });
});

describe("Review: the Follow-ups on a pass", () => {
  /** Each Open as issue link in a Verdict comment, read back as the new-issue form it opens. */
  function issueLinks(body: string): URL[] {
    return [...body.matchAll(/\[Open as issue\]\(([^)\s]+)\)/g)].map((match) => new URL(match[1]!));
  }

  function verdictCommentFor(output: string): string {
    return commentsOf(planFor(reviewed(output), snapshotOfPullRequest(aPullRequest()), kitConfig()))[0] ?? "";
  }

  it("a pass shows what the Reviewer checked, and each Follow-up with a link to open it as an issue on the Product repo", () => {
    const body = verdictCommentFor(
      "verdict: pass\n\nChecked the empty-cart case.\n\nfollow-ups:\n- The badge miscounts\n  Already wrong: `badge.ts`.\n- Tidy the footer\n  Crooked.",
    );

    expect(body).toContain("### Checked\n\nChecked the empty-cart case.");
    expect(body).toContain("### Follow-ups");
    expect(body).toContain("#### The badge miscounts\n\nAlready wrong: `badge.ts`.");
    const links = issueLinks(body);
    expect(links.map((link) => `${link.origin}${link.pathname}`)).toEqual([
      "https://github.com/acme/shop/issues/new",
      "https://github.com/acme/shop/issues/new",
    ]);
    expect(links.map((link) => [link.searchParams.get("title"), link.searchParams.get("body")])).toEqual([
      ["The badge miscounts", "Already wrong: `badge.ts`.\n\nFrom PR #50"],
      ["Tidy the footer", "Crooked.\n\nFrom PR #50"],
    ]);
    // The Follow-ups come before the run's link.
    expect(body.indexOf("### Follow-ups")).toBeLessThan(body.indexOf("[The run]"));
  });

  it("a pass with no Follow-ups has no Follow-ups part", () => {
    const body = verdictCommentFor("verdict: pass\n\nChecked it.");

    expect(body).toContain("### Checked\n\nChecked it.");
    expect(body).not.toContain("Follow-ups");
    expect(issueLinks(body)).toEqual([]);
  });

  it("an Execution flaw shows no Follow-ups part, even when the Reviewer named some", () => {
    const body = verdictCommentFor("verdict: execution-flaw\n\nFix the build.\n\nfollow-ups:\n- Tidy the footer\n  Crooked.");

    expect(body).toContain("Fix the build.");
    expect(body).not.toMatch(/Follow-ups|Tidy the footer|Open as issue|### Checked/);
  });

  it("a Follow-up's title and body mention nobody, in the comment or in the issue it opens", () => {
    const body = verdictCommentFor("verdict: pass\n\nChecked it.\n\nfollow-ups:\n- Ask @alice about it\n  And @bob too.");

    expect(body).not.toMatch(/@alice|@bob/);
    const [link] = issueLinks(body);
    expect(link?.searchParams.get("title")).not.toContain("@alice");
    expect(link?.searchParams.get("body")).not.toContain("@bob");
  });

  it("a long body is cut short to fit GitHub's URL limit, and still ends with the PR it came from", () => {
    const long = "word ".repeat(5000).trim();
    const body = verdictCommentFor(`verdict: pass\n\nChecked it.\n\nfollow-ups:\n- A big one\n  ${long}`);

    const [link] = issueLinks(body);
    expect(link?.href.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const prefilled = link?.searchParams.get("body") ?? "";
    expect(prefilled).toMatch(/^word word .*…\n\nFrom PR #50$/s);
    expect(prefilled.length).toBeLessThan(long.length);
    // The comment itself shows the whole body.
    expect(body).toContain(long);
  });

  it("a very long title is cut short too, so the link still opens", () => {
    const title = "x".repeat(9000);
    const [link] = issueLinks(verdictCommentFor(`verdict: pass\n\nChecked it.\n\nfollow-ups:\n- ${title}\n  Short body.`));

    expect(link?.href.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(link?.searchParams.get("title")).toMatch(/^x+…$/);
    expect(link?.searchParams.get("body")).toBe("Short body.\n\nFrom PR #50");
  });
});
