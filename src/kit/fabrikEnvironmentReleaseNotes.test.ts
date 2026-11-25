// The notes for the `fabrik` environment's part of the major that carries the
// Kit's Operator sessions (#915) are drafted ahead, beside the others (#935).
// While they are a draft they must say what the code does: the environment's
// name, the hand-off's job and inputs, the accounts' names and the report's
// heading each as the code holds them, and every name they give one the code
// holds under that name. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import type { ReadClient } from "../github/client.ts";
import { handOffFrom } from "../github/events.ts";
import { readHandOff } from "../github/handOff.ts";
import { KIT_ENVIRONMENT } from "./environment.ts";

const NOTES = "docs/release-notes/fabrik-environment.md";
const read = (path: string): string => readFileSync(join(KIT, path), "utf8");

/** The notes' section under `## heading`, up to the next one. */
const section = (notes: string, heading: string): string => notes.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";

/** The bullet of `text` that opens with `lead` in bold. */
const bullet = (text: string, lead: string): string => text.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";

/** The Spec, as the notes and the releasing guide link it. */
const SPEC = "[Spec: The Kit's tokens in the `fabrik` environment, which only the default branch may use](https://github.com/jrey8343/fabrik/issues/915)";

/** A job of a workflow, as much of it as these tests read. */
interface Job {
  readonly if?: string;
  readonly environment?: unknown;
  readonly permissions?: unknown;
  readonly steps?: readonly { readonly uses?: string }[];
  readonly secrets?: unknown;
}

/** The jobs of one of the Kit's workflows, or of a caller template, by their keys. */
const jobsOf = (path: string): Readonly<Record<string, Job>> => (parse(read(path)) as { jobs: Record<string, Job> }).jobs;

/** The Kit's four reusable workflows, and in each the jobs the notes say read no token, so name no environment. */
const READS_NO_TOKEN: Readonly<Record<string, readonly string[]>> = {
  "loop.yml": ["review-checks", "rerun-checks", "rerun-wait", "review-hand-off"],
  "schedule.yml": ["kit"],
  "weekly-summary.yml": ["kit"],
  "tick-check.yml": ["kit"],
};

/** A review as GitHub's REST API answers it: a Request changes on PR #45 of acme/shop, by `login`. */
const aReview = (login: string, state = "CHANGES_REQUESTED") => ({
  id: 123,
  node_id: "PRR_kwDO123",
  user: { login, type: "User" },
  body: "Use the parking copy.",
  state,
  pull_request_url: "https://api.github.com/repos/acme/shop/pulls/45",
});

/** A read-only GitHub that holds one review, 123 on PR #45 of acme/shop, and answers nothing else. */
const gitHubWith = (review: ReturnType<typeof aReview>): ReadClient => ({
  rest: (_method, path) => Promise.resolve(path === "/repos/acme/shop/pulls/45/reviews/123" ? review : null),
  graphql: () => Promise.reject(new Error("The hand-off's read makes no query")),
  fileText: () => Promise.reject(new Error("The hand-off's read reads no file")),
});

describe.skipIf(RELEASED_NOTES.has(NOTES))("The fabrik environment release notes, while drafted", () => {
  const notes = read(NOTES);
  const changed = section(notes, "What changed");

  it("open with their title, the major and the Spec they are a part of, and the paste line, in one paragraph", () => {
    const [title, blank, opening, after] = notes.split("\n");

    expect(title).toBe("# Release notes: the Kit's tokens in the `fabrik` environment");
    expect([blank, after]).toEqual(["", ""]);
    expect(opening).toMatch(/^These are the notes of this part of the major that carries the Kit's Operator sessions \(/);
    expect(opening).toContain(`the major that carries the Kit's Operator sessions (${SPEC})`);
    expect(opening?.endsWith("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.")).toBe(true);
  });

  it("are linked from the releasing guide's one entry for the Operator sessions major, after the Console check's, with no entry of their own", () => {
    const drafted =
      read("docs/releasing.md")
        .split("\n")
        .find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`")) ?? "";
    const [, ...entries] = drafted.split("the Operator sessions major's are ");

    // One entry for the major, which holds this draft's link by its text. The later parts add theirs to the same entry, so nothing here says it is the last.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("[the Kit's tokens in the `fabrik` environment](release-notes/fabrik-environment.md)");
    expect(entries[0]?.startsWith("[the Console check](release-notes/console-check.md)")).toBe(true);
  });

  it("give the environment's name as the code holds it, and name as reading no token exactly the jobs that name no environment", () => {
    const jobs = bullet(changed, "Each Kit job that reads a token names the `fabrik` environment");

    expect(jobs).toContain("names the caller repo's `fabrik` environment, with `deployment: false`");
    expect(jobs).toContain("The name is one constant, `KIT_ENVIRONMENT`, `fabrik`, in `src/kit/environment.ts`");
    expect(KIT_ENVIRONMENT).toBe("fabrik");
    expect(jobs).toContain("the Kit's four reusable workflows, `loop.yml`, `schedule.yml`, `weekly-summary.yml` and `tick-check.yml`");
    expect(jobs).toContain("A job that reads no token names none: `loop.yml`'s `review-checks`, `rerun-checks`, `rerun-wait` and `review-hand-off`, and the `kit` job of each of the other three.");

    for (const [file, readsNoToken] of Object.entries(READS_NO_TOKEN)) {
      const jobsOfFile = Object.entries(jobsOf(`.github/workflows/${file}`));
      const namingNone = jobsOfFile.filter(([, job]) => job.environment === undefined).map(([name]) => name);
      expect(namingNone.toSorted(), file).toEqual(readsNoToken.toSorted());
      for (const [name, job] of jobsOfFile.filter(([name]) => !readsNoToken.includes(name))) expect(job.environment, `${file}'s ${name}`).toEqual({ name: KIT_ENVIRONMENT, deployment: false });
    }
  });

  it("say the caller workflow's three secrets lines keep their names, as the caller template holds them", () => {
    expect(bullet(changed, "Each Kit job that reads a token names the `fabrik` environment")).toContain("The tokens keep their names, and the caller workflow's three `secrets:` lines don't change");
    expect(jobsOf("templates/fabrik.yml")["loop"]?.secrets).toEqual({
      OP_AGENT_TOKEN: "${{ secrets.FABRIK_OP_AGENT_TOKEN }}",
      OP_IMPLEMENT_TOKEN: "${{ secrets.FABRIK_OP_IMPLEMENT_TOKEN }}",
      OP_PUSH_TOKEN: "${{ secrets.FABRIK_OP_PUSH_TOKEN }}",
    });
  });

  it("name the review's hand-off job, what it holds and the event it runs on, as loop.yml holds them", () => {
    const handOff = bullet(changed, "A pull request review's run reads no token and hands off");
    expect(handOff).toContain("On a `pull_request_review` event the Kit job is skipped, and with it every job that needs it");
    expect(handOff).toContain("the run runs one job alone, `review-hand-off`");
    expect(handOff).toContain("It holds `actions: write` and nothing else, names no environment, reads no secret and checks nothing out");

    const loop = jobsOf(".github/workflows/loop.yml");
    const job = loop["review-hand-off"];
    expect(job).toMatchObject({ if: "github.event_name == 'pull_request_review'", permissions: { actions: "write" } });
    expect(job).not.toHaveProperty("environment");
    expect(job?.steps?.filter((step) => step.uses !== undefined)).toEqual([]);
    expect(read(".github/workflows/loop.yml").split("\n  review-hand-off:\n")[1]?.split("\n\n")[0]).not.toMatch(/\bsecrets[.[]/);
    expect(loop["kit"]?.if).toBe("github.event_name != 'pull_request_review'");
  });

  it("name the caller workflow's new trigger, its two inputs and the run's name, as the caller template holds them", () => {
    const handOff = bullet(changed, "A pull request review's run reads no token and hands off");
    expect(handOff).toContain("The caller workflow gains that trigger, with two required string inputs, `pull_request`, the pull request's number, and `review`, the review's id");
    expect(handOff).toContain("the run it starts is named `Review on PR #<number>, handed off`");

    const template = parse(read("templates/fabrik.yml")) as { on: { workflow_dispatch: { inputs: Record<string, { required: boolean; type: string }> } }; "run-name": string };
    expect(Object.keys(template.on.workflow_dispatch.inputs)).toEqual(["pull_request", "review"]);
    for (const input of Object.values(template.on.workflow_dispatch.inputs)) expect(input).toMatchObject({ required: true, type: "string" });
    expect(template["run-name"]).toContain("github.event_name == 'workflow_dispatch' && format('Review on PR #{0}, handed off', github.event.inputs.pull_request)");
  });

  it("say what an input must be to make a hand-off, as the run reads its inputs", () => {
    expect(bullet(changed, "A pull request review's run reads no token and hands off")).toContain("Each input must be a positive whole number with no leading zero, or the run does nothing");

    const dispatched = (inputs: Record<string, unknown>) => handOffFrom("workflow_dispatch", { inputs });
    expect(dispatched({ pull_request: "45", review: "123" })).toEqual({ pullRequest: 45, review: 123 });
    for (const written of ["045", "0", "-45", "4.5", "45abc", " 45", ""]) {
      expect(dispatched({ pull_request: written, review: "123" }), JSON.stringify(written)).toBeNull();
      expect(dispatched({ pull_request: "45", review: written }), JSON.stringify(written)).toBeNull();
    }
    expect(dispatched({ pull_request: "45" })).toBeNull();
  });

  it("say the run a review hands off to acts only on a review of the Operator's that GitHub holds, so anyone else's Request changes gets no line", async () => {
    const handOff = bullet(changed, "A pull request review's run reads no token and hands off");
    expect(handOff).toContain("act only on a review that is there, on that pull request, submitted and not dismissed, and written by the Operator (Kit config's `operator`, or the repo's owner), whatever the case of the login");
    const requested = bullet(changed, "A Request-changes run uses the default branch's caller workflow and Kit config");
    expect(requested).toContain("A Request changes from anyone but the Operator now gets no line at all");
    expect(requested).toContain("That line is the one behaviour the move loses.");

    const repo = { owner: "acme", name: "shop" };
    const named = { pullRequest: 45, review: 123 };
    expect(await readHandOff(gitHubWith(aReview("Operator")), repo, named, "operator")).toMatchObject({ kind: "pull-request-changes-requested", pullRequest: 45 });
    // Nothing is planned for anyone else's, a person's included, so nothing is said on the pull request.
    expect(await readHandOff(gitHubWith(aReview("someone-else")), repo, named, "operator")).toBeNull();
    expect(await readHandOff(gitHubWith(aReview("operator", "DISMISSED")), repo, named, "operator")).toBeNull();
    expect(await readHandOff(gitHubWith(aReview("operator")), repo, { pullRequest: 46, review: 123 }, "operator")).toBeNull();
  });
});
