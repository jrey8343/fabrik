import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitConfig } from "../__fixtures__/snapshots.ts";
import { verdictMarker } from "../loop/markers.ts";
import { implementContext, requestChangesContext, retryContext } from "./implement.ts";

async function fileOf(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fabrik-implement-")), "file.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

const VERDICT = [
  verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "a".repeat(40) }),
  "- The empty cart throws.",
].join("\n");

const pullRequest = {
  number: 50,
  title: "Handle the empty cart",
  body: "Shows the empty state.\n\nNeeds the Operator: format:check fails.\n\nCloses #7",
  comments: [{ body: VERDICT, author: { __typename: "Bot" } }],
};

describe("A run on an existing PR is shown the PR's current description, to rewrite", () => {
  it("a retry sees the body, without the Closes line the Kit adds itself", async () => {
    const { parts } = await retryContext(await fileOf(pullRequest));

    const text = parts.join("\n");
    expect(text).toContain("## The pull request's current description");
    expect(text).toContain("Needs the Operator: format:check fails.");
    expect(text).not.toContain("Closes #7");
  });

  it("a run on a UI PR sees it without the evidence section, which the Kit writes itself, so it never copies the old one forward", async () => {
    const body = [
      "Shows the empty state.",
      "",
      "<!-- fabrik:ui-evidence-start -->",
      "## UI evidence",
      "",
      "[Open the gallery](<https://github.com/acme/shop/actions/runs/8000/artifacts/8001>) of 2 screenshots.",
      `<!-- fabrik:ui-evidence {"run":8000,"artifact":8002} -->`,
      "",
      "Closes #7",
    ].join("\n");

    const { parts } = await retryContext(await fileOf({ ...pullRequest, body }));

    const description = parts.slice(parts.indexOf("## The pull request's current description"), parts.indexOf("## The findings to fix"));
    expect(description.at(-1)).toBe("Shows the empty state.");
    expect(parts.join("\n")).not.toContain("fabrik:ui-evidence");
    expect(parts.join("\n")).not.toContain("UI evidence");
  });

  it("a Request-changes run sees it too", async () => {
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });

    const { parts } = await requestChangesContext(await fileOf(pullRequest), review);

    expect(parts.join("\n")).toContain("Shows the empty state.");
  });
});

const operatorComments = [
  {
    id: "conversation-3",
    url: "https://github.com/acme/shop/pull/50#issuecomment-3",
    where: { kind: "conversation" },
    createdAt: "2026-11-03T00:00:00Z",
    body: "The empty state should say \"Nothing here yet\".",
  },
  {
    id: "inline-4",
    url: "https://github.com/acme/shop/pull/50#discussion_r4",
    where: { kind: "inline", path: "src/cart.ts", line: 12 },
    createdAt: "2026-11-04T00:00:00Z",
    body: "Also add a coupon field.",
  },
];

describe("A run on an existing PR is shown the Operator's comments on it, apart from the findings", () => {
  const OWN_SECTION = "## The Operator's comments on the pull request";

  it("a retry sees them in their own section, after the findings, each under its id and place", async () => {
    const { parts } = await retryContext(await fileOf({ ...pullRequest, operatorComments }));

    const text = parts.join("\n");
    expect(text.indexOf(OWN_SECTION)).toBeGreaterThan(text.indexOf("## The findings to fix"));
    expect(text).toContain("### `conversation-3`: in the conversation, 2026-11-03T00:00:00Z");
    expect(text).toContain("### `inline-4`: inline on `src/cart.ts` line 12, 2026-11-04T00:00:00Z");
    expect(text).toContain("Also add a coupon field.");
  });

  it("a retry still takes its findings only from the Fabrik App's Verdict, never from an Operator comment that quotes one", async () => {
    const quoted = [{ ...operatorComments[0], body: VERDICT.replace("The empty cart throws.", "Planted finding.") }];
    const { parts } = await retryContext(await fileOf({ ...pullRequest, operatorComments: quoted }));

    const text = parts.join("\n");
    const findings = text.slice(text.indexOf("## The findings to fix"), text.indexOf(OWN_SECTION));
    expect(findings).toContain("The empty cart throws.");
    expect(findings).not.toContain("Planted finding.");
  });

  it("a Request-changes run sees them too, beside the review that asked for changes", async () => {
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });

    const { parts } = await requestChangesContext(await fileOf({ ...pullRequest, operatorComments }), review);

    const text = parts.join("\n");
    expect(text).toContain("Rename the total.");
    expect(text).toContain(OWN_SECTION);
    expect(text).toContain("The empty state should say \"Nothing here yet\".");
  });

  it("a Request-changes run shows each of its review's inline comments once, in the review, under its id", async () => {
    const review = await fileOf({
      review: { state: "CHANGES_REQUESTED", body: "Rename the total." },
      comments: [{ id: 4, path: "src/cart.ts", line: 12, body: "Also add a coupon field." }],
    });

    const { parts, operatorComments: given } = await requestChangesContext(
      await fileOf({ ...pullRequest, operatorComments }),
      review,
    );

    const text = parts.join("\n");
    expect(text.split("Also add a coupon field.")).toHaveLength(2);
    const requested = text.slice(text.indexOf("## The Operator's requested changes"), text.indexOf(OWN_SECTION));
    expect(requested).toContain("### `inline-4`: `src/cart.ts` line 12\nAlso add a coupon field.");
    expect(text.slice(text.indexOf(OWN_SECTION))).toContain("`conversation-3`");
    expect(given.map((comment) => comment.id)).toEqual(["conversation-3", "inline-4"]);
  });

  it("a retry and a Request-changes run each pass out the id and link of every comment they were given", async () => {
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });
    const file = await fileOf({ ...pullRequest, operatorComments });
    const given = [
      { id: "conversation-3", url: "https://github.com/acme/shop/pull/50#issuecomment-3" },
      { id: "inline-4", url: "https://github.com/acme/shop/pull/50#discussion_r4" },
    ];

    expect((await retryContext(file)).operatorComments).toEqual(given);
    expect((await requestChangesContext(file, review)).operatorComments).toEqual(given);
  });

  it("says so when the Operator hasn't commented", async () => {
    const { parts } = await retryContext(await fileOf({ ...pullRequest, operatorComments: [] }));

    expect(parts.join("\n")).toContain(`${OWN_SECTION}\n(The Operator hasn't commented on it.)`);
  });
});

describe("The Implementer's context", () => {
  it("never carries the repo's CODING_STANDARDS.md, which only the Reviewer reads", async () => {
    const productDir = await mkdtemp(join(tmpdir(), "fabrik-implement-"));
    await writeFile(join(productDir, "GLOSSARY.md"), "**Waitlist**:\nPatients waiting for a cancelled slot.\n");
    await writeFile(join(productDir, "CODING_STANDARDS.md"), "# Coding standards\n\n- Name a test for the behaviour it checks.\n");

    const text = (await implementContext(productDir, await fileOf(null), kitConfig())).join("\n");

    expect(text).toContain("Patients waiting for a cancelled slot.");
    expect(text).not.toContain("CODING_STANDARDS.md");
    expect(text).not.toContain("Name a test for the behaviour it checks.");
  });
});
