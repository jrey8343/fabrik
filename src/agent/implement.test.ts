import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verdictMarker } from "../loop/markers.ts";
import { requestChangesContext, retryContext } from "./implement.ts";

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

  it("a Request-changes run sees it too", async () => {
    const review = await fileOf({ review: { state: "CHANGES_REQUESTED", body: "Rename the total." }, comments: [] });

    const { parts } = await requestChangesContext(await fileOf(pullRequest), review);

    expect(parts.join("\n")).toContain("Shows the empty state.");
  });
});
