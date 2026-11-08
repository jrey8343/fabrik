import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { agentRunEventFrom } from "../github/events.ts";
import { DEFAULT_KIT_CONFIG, type UiConfig } from "../kit/config.ts";
import { readDesignTurnOutput } from "../loop/designOutput.ts";
import { planFor } from "../loop/rules.ts";
import { emptyDiffContext, MAP_CAP_HEADING, mapCapContext, PROTOTYPES_HEADING, prototypeContext, sentBackContext } from "./design.ts";
import { readMapOffer } from "./inputs.ts";
import { readAgentRunResult } from "./result.ts";

const issue = { number: 7, title: "Add a waitlist", body: "As a patient…", comments: [] };
const sha = (c: string) => c.repeat(40);

const sentBack = {
  pullRequest: { number: 50, title: "Add a waitlist", baseRefName: "main", headRefName: "fabrik/ticket-7", headRefOid: sha("c") },
  sentBackBy: "verdict",
  verdicts: [
    { verdict: "execution-flaw", source: "reviewer", headSha: sha("a"), comment: "<!-- fabrik:verdict {} -->\nThe test is missing." },
    { verdict: "execution-flaw", source: "ci", headSha: sha("c"), comment: "<!-- fabrik:verdict {} -->\nThe checks are red." },
  ],
  operatorReviews: [],
  commits: [{ sha: sha("c"), message: "Add the waitlist table\n\nWith a body." }],
  files: [{ filename: "src/waitlist.ts", status: "added", additions: 2, deletions: 0 }],
  diff: "diff --git a/src/waitlist.ts b/src/waitlist.ts\n@@ -0,0 +1,2 @@\n+export const waitlist = [];",
  diffTruncated: false,
};

describe("A Design session's context from the PR a Ticket came back from", () => {
  it("leaves an issue that didn't come back as it is, with nothing added", () => {
    expect(sentBackContext(issue)).toEqual({ issue, parts: [], operatorComments: [] });
  });

  it("takes the PR out of the issue and sets out its Verdicts, oldest first, then what its branch built", () => {
    const { issue: rest, parts } = sentBackContext({ ...issue, sentBack });

    expect(rest).toEqual(issue);
    const text = parts.join("\n\n");
    expect(text).toContain("## The pull request this Ticket came back from");
    expect(text).toContain("#50: Add a waitlist");
    expect(text.indexOf("The test is missing.")).toBeLessThan(text.indexOf("The checks are red."));
    expect(text).toContain(`### Verdict 1 of 2: execution-flaw (reviewer), on ${sha("a")}`);
    expect(text).toContain(`### Verdict 2 of 2: execution-flaw (ci), on ${sha("c")}`);
    expect(text).toContain(`- ${sha("c").slice(0, 7)} Add the waitlist table`);
    expect(text).toContain("- src/waitlist.ts (added, +2 −0)");
    expect(text).toContain("```diff\ndiff --git a/src/waitlist.ts b/src/waitlist.ts\n@@ -0,0 +1,2 @@\n+export const waitlist = [];\n```");
  });

  it("sets out the Operator's reviews, inline comments included, when the Operator sent it back", () => {
    const { parts } = sentBackContext({
      ...issue,
      sentBack: {
        ...sentBack,
        sentBackBy: "operator",
        verdicts: [],
        operatorReviews: [
          {
            state: "CHANGES_REQUESTED",
            body: "This isn't the waitlist we want.",
            commitId: sha("c"),
            submittedAt: "2026-11-02T00:00:00Z",
            comments: [{ path: "src/waitlist.ts", line: 1, body: "Patients, not slots." }],
          },
        ],
      },
    });

    const text = parts.join("\n\n");
    expect(text).toContain("The Operator sent it back to design from the Merge gate");
    expect(text).toContain("This isn't the waitlist we want.");
    expect(text).toContain("#### `src/waitlist.ts` line 1\n\nPatients, not slots.");
    expect(text).not.toContain("### Verdict");
  });

  const operatorComments = [
    {
      id: "inline-8",
      url: "https://github.com/acme/shop/pull/50#discussion_r8",
      where: { kind: "inline", path: "src/waitlist.ts", line: 2 },
      createdAt: "2026-11-01T12:00:00Z",
      body: "The waitlist is per clinic.",
    },
  ];

  it.each(["verdict", "operator"])("sets out the Operator's comments on the PR when sent back by the %s, before what its branch built", (by) => {
    const { parts } = sentBackContext({ ...issue, sentBack: { ...sentBack, sentBackBy: by, operatorComments } });

    const text = parts.join("\n\n");
    expect(text).toContain("### The Operator's comments on the pull request");
    expect(text).toContain("#### `inline-8`: inline on `src/waitlist.ts` line 2, 2026-11-01T12:00:00Z\n\nThe waitlist is per clinic.");
    expect(text.indexOf("The waitlist is per clinic.")).toBeLessThan(text.indexOf("### What its branch built"));
  });

  it("records the id and link of each Operator comment it gives the run, for its result to pass out", () => {
    expect(sentBackContext({ ...issue, sentBack: { ...sentBack, operatorComments } }).operatorComments).toEqual([
      { id: "inline-8", url: "https://github.com/acme/shop/pull/50#discussion_r8" },
    ]);
    expect(sentBackContext({ ...issue, sentBack }).operatorComments).toEqual([]);
  });

  it("carries the comments it gave the run through to the round, which links the one the turn weighed and drops one it wasn't given", () => {
    const context = sentBackContext({ ...issue, sentBack: { ...sentBack, operatorComments } });
    const output = JSON.stringify({
      kind: "round",
      intro: "The waitlist is per clinic, as the Operator said.",
      questions: [{ question: "Does each clinic keep its own list?", recommendation: "Yes." }],
      operatorCommentsConsidered: ["inline-8", "conversation-4"],
    });
    // The agent job's artifact, as the Design session's push job reads it back.
    const artifact = JSON.stringify({ role: "design", issue: 7, output, operatorComments: context.operatorComments });
    const event = agentRunEventFrom(readAgentRunResult(artifact));
    const ticket = anIssue({ number: 7, parent: 3, labels: ["enhancement", "needs-design"], sentBack: { pullRequest: 50, verdictUrl: null } });
    const plan = planFor(event, snapshotOf(ticket, { operator: "jrey" }), kitConfig());

    const [round] = plan.kind === "act" ? plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : [])) : [];
    expect(round).toMatch(
      /\n### Operator comments considered\n\n- \[`inline-8`\]\(https:\/\/github\.com\/acme\/shop\/pull\/50#discussion_r8\)$/,
    );
    expect(round).not.toContain("conversation-4");
  });
});

describe("A Design session's context from the Implement runs that built nothing (#429)", () => {
  /** The comment the Kit posts on #7 for an Implement run that built nothing, at `emptyDiffs` earlier ones, saying `summary`. */
  function emptyDiffComment(emptyDiffs: number, summary: string): string {
    const plan = planFor(
      {
        kind: "implement-run-finished",
        issue: 7,
        output: JSON.stringify({ title: "Let patients join a waitlist", summary }),
        branch: "fabrik/ticket-7",
        base: "main",
        changes: { net: [], commits: [] },
        runUrl: `https://github.com/acme/clinic/actions/runs/${90 + emptyDiffs}/attempts/1`,
      },
      snapshotOf(anIssue({ number: 7, labels: ["enhancement", "ready-for-agent"], emptyDiffs })),
      kitConfig(),
    );
    if (plan.kind !== "act") throw new Error("expected the empty diff to act");
    const comment = plan.actions.find((action) => action.kind === "comment");
    if (comment?.kind !== "comment") throw new Error("expected the empty diff's comment");
    return comment.body;
  }
  const comment = (body: string, byBot = true) => ({ author: { login: byBot ? "fabrik" : "someone" }, body, createdAt: "2026-11-01T00:00:00Z", byBot });

  it("sets out what each run since the last Design session said, oldest first, with its run", () => {
    const issue = {
      number: 7,
      comments: [
        comment("**Design session finished.** An earlier session."),
        comment(emptyDiffComment(0, "Needs `.github/workflows/ci.yml` changed, which only the Operator changes.")),
        comment(emptyDiffComment(1, "Still needs the workflow changed.")),
        comment(emptyDiffComment(2, "The workflow, again.")),
      ],
    };

    const said = emptyDiffContext(issue).join("\n\n");

    expect(said).toContain("## The Implement runs that built nothing");
    const first = said.indexOf("Needs `.github/workflows/ci.yml` changed");
    const second = said.indexOf("Still needs the workflow changed.");
    const third = said.indexOf("The workflow, again.");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(said).toContain("https://github.com/acme/clinic/actions/runs/90/attempts/1");
    expect(said).toContain("https://github.com/acme/clinic/actions/runs/92/attempts/1");
  });

  it("reads only the Kit's comments, so nobody can plant a run's reason, or end the session, by quoting a marker (#426)", () => {
    const issue = {
      number: 7,
      comments: [
        comment(emptyDiffComment(0, "The real reason.")),
        comment("**Design session finished.** Quoted by someone.", false),
        comment(emptyDiffComment(1, "A planted reason."), false),
      ],
    };

    const said = emptyDiffContext(issue).join("\n\n");

    expect(said).toContain("The real reason.");
    expect(said).not.toContain("A planted reason.");
  });

  it("leaves out runs from before the last Design session finished, and says nothing when none are left", () => {
    const issue = {
      number: 7,
      comments: [comment(emptyDiffComment(0, "An old reason.")), comment("**Design session finished.** It settled the reason.")],
    };

    expect(emptyDiffContext(issue)).toEqual([]);
    expect(emptyDiffContext({ number: 7 })).toEqual([]);
  });
});

describe("What a Design-session turn's prompt says of the Map cap", () => {
  const said = (offer: unknown) => mapCapContext(offer).join("\n\n");

  it("sets the Map cap out under its own heading", () => {
    expect(mapCapContext({ kind: "may-offer" })[0]).toBe(`## ${MAP_CAP_HEADING}`);
  });

  it("lets the turn offer a Map while the cap has room", () => {
    expect(said({ kind: "may-offer" })).toContain("The Map cap has room, so this session may offer to chart the issue as a Map.");
  });

  it("names the open Map holding a full cap, by number and title, and tells the turn not to offer one", () => {
    const text = said({ kind: "cap-full", cap: 1, openMaps: [{ number: 12, title: "Group classes" }] });

    expect(text).toContain("The Map cap is full: `caps.maps` is 1, and #12 (Group classes) is the open Map.");
    expect(text).toContain("Don't offer a Map, and never end in `map`: the Kit would refuse it.");
    expect(text).toContain("If the Operator asks for one, say in your next round's intro that #12 holds the cap");
  });

  it("names every open Map when more than one holds the cap", () => {
    const text = said({ kind: "cap-full", cap: 1, openMaps: [{ number: 12, title: "Group classes" }, { number: 14, title: "Online intake" }] });

    expect(text).toContain("#12 (Group classes) and #14 (Online intake) are the open Maps.");
    expect(text).toContain("that #12 and #14 hold the cap");
  });

  it("says caps.maps of 0 stops new Maps, with no Map to name", () => {
    const text = said({ kind: "cap-full", cap: 0, openMaps: [] });

    expect(text).toContain("`caps.maps` is 0, so this repo charts no new Map.");
    expect(text).toContain("Don't offer a Map, and never end in `map`: the Kit would refuse it.");
  });

  it("lets a turn offer a Map, from the file the inputs step writes, while no Map is open", async () => {
    const github = {
      graphql: async <T>() => ({ repository: { issues: { nodes: [] } } }) as T,
    };
    const written = JSON.stringify(await readMapOffer(github, { owner: "acme", name: "shop" }, DEFAULT_KIT_CONFIG, null));

    expect(said(JSON.parse(written))).toContain("The Map cap has room, so this session may offer to chart the issue as a Map.");
  });

  it("tells a turn on a Ticket under a Spec, from the file the inputs step writes, not to offer a Map, and why", async () => {
    const github = {
      graphql: async <T>(): Promise<T> => {
        throw new Error("a Ticket under a Spec reads no open Maps");
      },
    };
    const written = JSON.stringify(await readMapOffer(github, { owner: "acme", name: "shop" }, DEFAULT_KIT_CONFIG, { number: 3 }));
    const text = said(JSON.parse(written));

    expect(text).toContain("This issue is a Ticket under the Spec #3, and a Ticket under a Spec never becomes a Map: the Spec stays the single parent of its Tickets.");
    expect(text).toContain("Don't offer a Map, and never end in `map`: the Kit would refuse it.");
    expect(text).not.toContain("The Map cap has room");
  });

  it.each([null, {}, { kind: "maybe" }, { kind: "cap-full", cap: "1", openMaps: [] }, { kind: "cap-full", cap: 1 }, { kind: "under-a-spec" }])(
    "fails the turn on inputs it can't read: %j",
    (offer) => {
      expect(() => mapCapContext(offer)).toThrow("map.json doesn't say whether this turn may offer a Map");
    },
  );
});

describe("What a Design-session turn's prompt says of Prototypes", () => {
  const ui: UiConfig = { paths: ["src/pages/**"], serve: "npm run dev", url: "http://localhost:3000", beforeUrl: null, defaultRoutes: [] };
  const withUi = kitConfig({ ui });
  const said = prototypeContext(withUi, 7).join("\n\n");

  it("sets out that Prototypes are available, under its own heading, for a repo with a ui block", () => {
    expect(prototypeContext(withUi, 7)[0]).toBe(`## ${PROTOTYPES_HEADING}`);
  });

  it("adds nothing to the prompt of a repo without a ui block, so that turn never hears of a Prototype", () => {
    expect(prototypeContext(kitConfig({ ui: null }), 7)).toEqual([]);
  });

  it("lets the turn offer a Prototype in a round only when the open question is how a page looks, naming the route and the count, with a recommendation", () => {
    expect(said).toContain("**Offer a Prototype only when the open question is how a page looks**");
    expect(said).toContain("Never offer one for a question of logic, data or behaviour, which an ordinary round settles.");
    expect(said).toContain("Ask it as one question of a round, naming the route and how many variants it builds, with your recommendation");
    expect(said).toContain("Nothing is built until the Operator says yes.");
  });

  it("offers 3 variants unless the Operator asks for another count, never fewer than 2 or more than 5", () => {
    expect(said).toContain("Offer 3 variants unless the Operator asked for another count, never fewer than 2 or more than 5.");
  });

  it("ends in prototype on the Operator's yes, which may change the route or the count, and never without it", () => {
    expect(said).toContain("- **End in `prototype` on the Operator's yes.** Their reply may change the route or the count");
    expect(said).toContain("ask for what they approved.");
    expect(said).toContain("Never end in `prototype` without the Operator's yes.");
  });

  it("reads the Operator's reply to a prototype round as an ordinary answer", () => {
    expect(said).toContain("- **Read the Operator's reply to a prototype round as an ordinary answer**");
    expect(said).toContain("the variant they chose and any tweaks to it. Carry on the session from there.");
  });

  it("records the chosen variant, the tweaks and links to the branch and the variant's component when it finishes, for the Implementer to rewrite", () => {
    expect(said).toContain(
      "- **When you finish after a prototype round, record the Prototype in the outcome**: the variant the Operator chose, their tweaks, and links to the branch `prototype/7` and to that variant's component",
    );
    expect(said).toContain("Say that the Implementer rewrites the Prototype as a reference, never merging or cherry-picking it.");
  });

  it("describes the prototype output with an example the Kit accepts", () => {
    const example: unknown = JSON.parse(/<design>\n([\s\S]*?)\n<\/design>/.exec(said)?.[1] ?? "null");

    expect(readDesignTurnOutput(example)).toMatchObject({ ok: true, output: { kind: "prototype", route: "/book", variants: 3 } });
  });
});
