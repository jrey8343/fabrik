import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aPullRequest, kitConfig, snapshotOfPullRequest } from "../__fixtures__/snapshots.ts";
import { reviewEventFrom } from "../github/events.ts";
import { verdictMarker } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import { readPullRequest, type Reader } from "./inputs.ts";
import { readAgentRunResult } from "./result.ts";
import { reviewContext } from "./review.ts";

async function inputs(pullRequest: unknown): Promise<{ productDir: string; pullRequestFile: string; specFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-review-"));
  const pullRequestFile = join(dir, "pull-request.json");
  const specFile = join(dir, "spec.json");
  await writeFile(pullRequestFile, JSON.stringify(pullRequest));
  await writeFile(specFile, "null");
  return { productDir: dir, pullRequestFile, specFile };
}

const pullRequest = {
  number: 50,
  title: "Add parking info",
  body: "Adds the parking section.\n\nQuestions for the Operator: is the parking copy right?\n\nCloses #7",
  baseRefName: "main",
  headRefName: "fabrik/ticket-7",
  headRefOid: "a".repeat(40),
  operatorComments: [
    {
      id: "conversation-3",
      url: "https://github.com/acme/shop/pull/50#issuecomment-3",
      where: { kind: "conversation" },
      createdAt: "2026-11-03T00:00:00Z",
      body: "Yes, the parking copy is right.",
    },
    {
      id: "review-5",
      url: "https://github.com/acme/shop/pull/50#pullrequestreview-5",
      where: { kind: "review", state: "COMMENTED" },
      createdAt: "2026-11-04T00:00:00Z",
      body: "Looks close.",
    },
  ],
};

describe("A Review's context", () => {
  it("sets out the Operator's comments in their own section after the PR, each under its id and place", async () => {
    const { productDir, pullRequestFile, specFile } = await inputs(pullRequest);

    const { pullRequest: number, parts } = await reviewContext(productDir, pullRequestFile, specFile);

    expect(number).toBe(50);
    const text = parts.join("\n");
    expect(text.indexOf("## The Operator's comments on the pull request")).toBeGreaterThan(text.indexOf("## The pull request"));
    expect(text).toContain("### `conversation-3`: in the conversation, 2026-11-03T00:00:00Z\nYes, the parking copy is right.");
    expect(text).toContain("### `review-5`: in a review (COMMENTED), 2026-11-04T00:00:00Z\nLooks close.");
    // Set out once, in their own section, not again inside the PR's JSON.
    expect(text.split("Yes, the parking copy is right.").length).toBe(2);
  });

  it("replays penrith#39: the Operator's answer on the PR reaches the Review after the retry, the Verdict and fix comment don't, and its Verdict lists the answer as considered", async () => {
    const bot = { login: "fabrik-app[bot]", type: "Bot" };
    const at = (n: number) => `2026-10-2${n}T00:00:00Z`;
    const conversation = [
      // The first Review's Verdict, the retry's fix comment, the Operator's answer to the PR body's question, and a drive-by.
      { id: 1, user: bot, created_at: at(1), body: `${verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "b".repeat(40) })}\n**Verdict: Execution flaw.** The map link is broken.` },
      { id: 2, user: { login: "operator", type: "User" }, created_at: at(2), body: "The parking copy is right: free after 6pm." },
      { id: 3, user: bot, created_at: at(3), body: "**Fixed.** The map link now opens the clinic." },
      { id: 4, user: { login: "neighbour", type: "User" }, created_at: at(4), body: "Make parking paid." },
    ].map((comment) => ({ ...comment, html_url: `https://github.com/jrey8343/penrith/pull/39#issuecomment-${comment.id}` }));
    const github: Reader = {
      graphql: async <T>() =>
        ({
          repository: {
            pullRequest: {
              number: 39,
              title: "Add parking info",
              body: "Adds the parking section.\n\nCould the Operator check the parking copy?",
              baseRefName: "main",
              headRefName: "fabrik/ticket-12",
              headRefOid: "c".repeat(40),
              comments: { nodes: conversation.map(({ body, user }) => ({ body, author: { __typename: user.type } })) },
            },
          },
        }) as T,
      rest: async (_method: string, path: string) => {
        const [route, query] = path.split("?");
        if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
        if (route === "/repos/jrey8343/penrith/issues/39/comments") return conversation;
        if (route === "/repos/jrey8343/penrith/pulls/39/comments" || route === "/repos/jrey8343/penrith/pulls/39/reviews") return [];
        throw new Error(`unexpected REST call ${path}`);
      },
    };

    // The Review's input step, then the Review's prompt.
    const read = await readPullRequest(github, { owner: "jrey8343", name: "penrith" }, 39, { withComments: false, operator: "operator" });
    const { productDir, pullRequestFile, specFile } = await inputs(read);
    const context = await reviewContext(productDir, pullRequestFile, specFile);
    const text = context.parts.join("\n");

    expect(text).toContain("## The Operator's comments on the pull request");
    expect(text).toContain("### `conversation-2`: in the conversation, 2026-10-22T00:00:00Z\nThe parking copy is right: free after 6pm.");
    expect(read).toMatchObject({ operatorComments: [{ id: "conversation-2", url: "https://github.com/jrey8343/penrith/pull/39#issuecomment-2" }] });
    expect(text).not.toContain("The map link is broken.");
    expect(text).not.toContain("The map link now opens the clinic.");
    expect(text).not.toContain("Make parking paid.");

    // The Reviewer weighs the answer, and names the drive-by too, which it was never given.
    const reply = "verdict: pass\n\nThe parking copy is as the Operator confirmed.\n\noperator comments considered: conversation-2, conversation-4";
    // The agent job's artifact, as the Review's push job reads it back.
    const artifact = JSON.stringify({ role: "review", issue: 39, output: reply, operatorComments: context.operatorComments });
    const event = reviewEventFrom({
      pullRequest: 39,
      headSha: "c".repeat(40),
      runUrl: "https://github.com/jrey8343/penrith/actions/runs/7",
      repoUrl: "https://github.com/jrey8343/penrith",
      failedChecks: [],
      result: readAgentRunResult(artifact),
    });
    const plan = planFor(
      event,
      snapshotOfPullRequest(aPullRequest({ number: 39, ticket: 12, headSha: "c".repeat(40) })),
      kitConfig(),
    );

    const verdict = plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []))[0] : "";
    expect(verdict).toMatch(
      /\n### Operator comments considered\n\n- \[`conversation-2`\]\(https:\/\/github\.com\/jrey8343\/penrith\/pull\/39#issuecomment-2\)$/,
    );
    expect(verdict).not.toContain("conversation-4");
  });
});
