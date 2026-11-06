import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import type { CaptureResult } from "../evidence/uiEvidence.ts";
import { designSessionOf, designTurnFailedIn, pendingPrototypeIn } from "../github/threads.ts";
import type { PrototypeRequestMarker } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { IssueSnapshot, LoopEvent, Plan, Snapshot } from "./types.ts";

type PrototypeRunFinished = Extract<LoopEvent, { kind: "prototype-run-finished" }>;

const REPO = "https://github.com/acme/shop";
const RUN = `${REPO}/actions/runs/9100/attempts/1`;
const GALLERY = `${REPO}/actions/runs/9100/artifacts/9201`;
/** The head the prototype turn left prototype/7 at, which its push leaves the branch at. */
const HEAD = "7e3d1c9b5a4f2e0d8c6b4a2f0e9d7c5b3a1f0e2d";

/** What the Operator approved, in the reply 9001: the request the Kit job routed to the prototype job. */
const REQUEST: PrototypeRequestMarker = {
  request: { route: "/book", variants: 3, brief: "- **A**: one long form.\n- **B**: a stepper.\n- **C**: a calendar first." },
  reply: 9001,
};

/** The prototype turn's prototype-round: three variants of /book, and the one it recommends. */
const ROUND = {
  kind: "prototype-round",
  intro: "Three ways to book a class, all on `/book`.",
  variants: [
    { summary: "One long form, every field on the page.", component: "src/pages/book/LongForm.tsx" },
    { summary: "A stepper: class, time, then details.", component: "src/pages/book/Stepper.tsx" },
    { summary: "A calendar first, the form beside it.", component: "src/pages/book/CalendarFirst.tsx" },
  ],
  recommendation: "B, with the calendar from C on its first step.",
};

/** Each variant captured at both Kit viewports, with its load-and-scroll video. */
const CAPTURED: CaptureResult = {
  outcome: "captured",
  headSha: HEAD,
  captures: ["A", "B", "C"].flatMap((variant) =>
    (["mobile", "desktop"] as const).map((viewport) => ({
      route: "/book",
      variant,
      viewport,
      status: 200,
      image: `variant-${variant.toLowerCase()}-${viewport}.png`,
      video: `variant-${variant.toLowerCase()}-${viewport}.webm`,
    })),
  ),
};

/** The push job of run 9100 after the prototype turn on #7: its round, its commits on prototype/7, and what capture recorded. */
function finished(overrides: Partial<PrototypeRunFinished> = {}): PrototypeRunFinished {
  const variants = ROUND.variants.map(({ component }) => ({ path: component }));
  return {
    kind: "prototype-run-finished",
    issue: 7,
    output: JSON.stringify(ROUND),
    request: REQUEST,
    branch: "prototype/7",
    changes: { net: variants, commits: variants },
    headSha: HEAD,
    capture: CAPTURED,
    gallery: GALLERY,
    runUrl: RUN,
    repoUrl: REPO,
    ...overrides,
  };
}

/** #7 two rounds into its Design session, its request still pending and the reply that approved it still there. */
function inSession(issue: Partial<IssueSnapshot> = {}, overrides: Partial<Omit<Snapshot, "issue">> = {}): Snapshot {
  return snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 2, pendingPrototype: REQUEST, ...issue }), {
    operator: "jrey",
    startingComment: { id: 9001, exists: true },
    ...overrides,
  });
}

function commentsOf(plan: Plan): string[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

const DESIGN = DEFAULT_KIT_CONFIG.roles.design;

const blob = (path: string) => `${REPO}/blob/${HEAD}/${path}`;

describe("Landing a captured prototype turn", () => {
  it("pushes prototype/7, then posts the prototype round numbered after the last: its intro, the branch and the gallery, every variant with its component at the pushed head, and \"Which variant?\" with the recommendation", () => {
    const plan = planFor(finished(), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "push-prototype-branch", issue: 7 },
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-round 3 -->",
            "<!-- fabrik:prototype-round -->",
            "@jrey **Design session, round 3: the prototype.** Reply with the variant you'd build, and any changes to it, or `yes` to take the recommendation.",
            "",
            "Three ways to book a class, all on `/book`.",
            "",
            `[The prototype branch](${REPO}/tree/prototype/7) · [The gallery](${GALLERY}) of each variant's screenshots and videos. The gallery expires in about 30 days, so this comment is the prototype's record.`,
            "",
            `- **A.** One long form, every field on the page. [\`src/pages/book/LongForm.tsx\`](${blob("src/pages/book/LongForm.tsx")})`,
            `- **B.** A stepper: class, time, then details. [\`src/pages/book/Stepper.tsx\`](${blob("src/pages/book/Stepper.tsx")})`,
            `- **C.** A calendar first, the form beside it. [\`src/pages/book/CalendarFirst.tsx\`](${blob("src/pages/book/CalendarFirst.tsx")})`,
            "",
            "**1. Which variant?**",
            "➡️ Recommended: B, with the calendar from C on its first step.",
          ].join("\n"),
        },
      ],
    });
  });

  it("says so when the prototype job kept no gallery, the round still the record", () => {
    const [round] = commentsOf(planFor(finished({ gallery: null }), inSession(), kitConfig()));

    expect(round).toContain(
      `\n[The prototype branch](${REPO}/tree/prototype/7) · The Kit kept no gallery of the captures, so this comment is the prototype's record.\n`,
    );
  });

  it("strips the agent's text of mentions, and links a component whose path could end its link early", () => {
    const round = {
      ...ROUND,
      intro: "As @jrey asked, three ways.",
      variants: [
        { summary: "The form @design-team sketched.", component: "src/pages/book/Long Form (wide).tsx" },
        ...ROUND.variants.slice(1),
      ],
      recommendation: "B, as @jrey said.",
    };

    const plan = planFor(finished({ output: JSON.stringify(round) }), inSession(), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual(["mention on #7"]);
    expect(commentsOf(plan)[0]).not.toMatch(/@design-team/);
    expect(commentsOf(plan)[0]).toContain(
      `- **A.** The form @\u200bdesign-team sketched. [\`src/pages/book/Long Form (wide).tsx\`](${blob("src/pages/book/Long%20Form%20%28wide%29.tsx")})`,
    );
  });

  it("notifies the Operator once, by the round's one @-mention, and never ends the Design session", () => {
    const plan = planFor(finished(), inSession(), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual(["mention on #7"]);
    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["push-prototype-branch", "comment"]);
  });
});

describe("Landing a prototype turn whose capture failed after it built", () => {
  const failed = (reason: string): CaptureResult => ({ ...CAPTURED, outcome: "failed", reason, captures: [] }) as CaptureResult;

  it.each([
    ["timeout", "capture ran out of time"],
    ["error", `capture hit an error the Kit didn't expect, which [the run](${RUN}) shows`],
    ["no-variants", "capture found no variant to capture in the turn's output"],
  ])("still pushes the branch and asks \"Which variant?\", giving the reason in place of the gallery, when it failed with %s", (reason, words) => {
    const plan = planFor(finished({ capture: failed(reason), gallery: null }), inSession(), kitConfig());

    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["push-prototype-branch", "comment"]);
    const [round] = commentsOf(plan);
    expect(round).toMatch(/^<!-- fabrik:design-round 3 -->\n<!-- fabrik:prototype-round -->\n@jrey \*\*Design session, round 3: the prototype\.\*\*/);
    expect(round).toContain(
      `\n[The prototype branch](${REPO}/tree/prototype/7) · There's no gallery: ${words}. The branch holds the variants, and this comment is the prototype's record.\n`,
    );
    expect(round).toContain(`- **B.** A stepper: class, time, then details. [\`src/pages/book/Stepper.tsx\`](${blob("src/pages/book/Stepper.tsx")})`);
    expect(round).toMatch(/\n\*\*1\. Which variant\?\*\*\n➡️ Recommended: B, with the calendar from C on its first step\.$/);
  });

  it("gives the reason as no capture result when the prototype job passed out none the push job could read", () => {
    const [round] = commentsOf(planFor(finished({ capture: undefined, gallery: null }), inSession(), kitConfig()));

    expect(round).toContain(
      "There's no gallery: the prototype job passed out no capture result the push job could read. The branch holds the variants,",
    );
    expect(round).toContain("**1. Which variant?**");
  });
});

describe("Landing a prototype turn whose build or dev server failed", () => {
  const failed = (reason: "build-failed" | "server-did-not-start"): CaptureResult => ({ outcome: "failed", reason, headSha: HEAD, captures: [] });

  it("pushes the branch, then posts a prototype failure round numbered after the last, saying what failed, linking the branch, and asking whether to carry on without a prototype, recommending it", () => {
    const plan = planFor(finished({ capture: failed("build-failed"), gallery: null }), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "push-prototype-branch", issue: 7 },
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-round 3 -->",
            "<!-- fabrik:prototype-failed -->",
            "@jrey **Design session, round 3: the prototype failed.** Reply with how you'd go on, or `yes` to take the recommendation.",
            "",
            `The Kit pushed the variants the prototype turn wrote to [\`prototype/7\`](${REPO}/tree/prototype/7), but \`sandbox.build\` failed, so there was no build to serve, and nothing to look at. [The run](${RUN}) has the log.`,
            "",
            "**1. Carry on without a prototype, or try again?**",
            "➡️ Recommended: Carry on without a prototype. Trying again spends another prototype turn's Sandbox time, and may fail the same way.",
          ].join("\n"),
        },
      ],
    });
    expect(notificationsOf(plan, "jrey")).toEqual(["mention on #7"]);
  });

  it("says the dev server didn't start when it never answered", () => {
    const [round] = commentsOf(planFor(finished({ capture: failed("server-did-not-start"), gallery: null }), inSession(), kitConfig()));

    expect(round).toContain(
      "but the dev server wouldn't start: nothing answered at `ui.url` once `ui.serve` ran, and nothing to look at.",
    );
    expect(round).toContain("**1. Carry on without a prototype, or try again?**");
  });
});

// The preview (#153's preview.url): the push job polls it once the round is posted, and links it then.
describe("The preview of each variant, when Kit config declares preview.url", () => {
  const PREVIEW = { url: "https://{branch_slug}--shop.netlify.app" };

  it("says in the round that each variant's preview is linked beside it once it answers, and asks the push job to link it in that round once it has pushed", () => {
    const plan = planFor(finished(), inSession(), kitConfig({ ui: UI, preview: PREVIEW }));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "push-prototype-branch", issue: 7 },
        {
          kind: "comment",
          issue: 7,
          key: "prototype-round",
          body: [
            "<!-- fabrik:design-round 3 -->",
            "<!-- fabrik:prototype-round -->",
            "@jrey **Design session, round 3: the prototype.** Reply with the variant you'd build, and any changes to it, or `yes` to take the recommendation.",
            "",
            "Three ways to book a class, all on `/book`.",
            "",
            `[The prototype branch](${REPO}/tree/prototype/7) · [The gallery](${GALLERY}) of each variant's screenshots and videos. The gallery expires in about 30 days, so this comment is the prototype's record.`,
            "",
            `- **A.** One long form, every field on the page. [\`src/pages/book/LongForm.tsx\`](${blob("src/pages/book/LongForm.tsx")})`,
            `- **B.** A stepper: class, time, then details. [\`src/pages/book/Stepper.tsx\`](${blob("src/pages/book/Stepper.tsx")})`,
            `- **C.** A calendar first, the form beside it. [\`src/pages/book/CalendarFirst.tsx\`](${blob("src/pages/book/CalendarFirst.tsx")})`,
            "",
            "Each variant's preview is linked beside it once the preview deployment answers.",
            "",
            "**1. Which variant?**",
            "➡️ Recommended: B, with the calendar from C on its first step.",
          ].join("\n"),
        },
        { kind: "link-prototype-preview", issue: 7, round: { posted: "prototype-round" }, template: PREVIEW.url, route: "/book" },
      ],
    });
  });

  it("links it in the round of a prototype whose capture failed after it built too, since the variants are still there to open", () => {
    const capture: CaptureResult = { ...CAPTURED, outcome: "failed", reason: "timeout", captures: [] };

    const plan = planFor(finished({ capture, gallery: null }), inSession(), kitConfig({ ui: UI, preview: PREVIEW }));

    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["push-prototype-branch", "comment", "link-prototype-preview"]);
    expect(commentsOf(plan)[0]).toContain(
      "\n\nEach variant's preview is linked beside it once the preview deployment answers.\n\n**1. Which variant?**\n",
    );
  });

  it.each([
    ["the PR's number", "https://deploy-preview-{pr}--shop.netlify.app"],
    ["the PR's number beside the branch", "https://pr-{pr}.shop.example.dev/{branch_slug}/{sha}"],
  ])("says there's no preview for prototypes, and asks for none, when the template names %s, which a prototype hasn't got", (_name, url) => {
    const plan = planFor(finished(), inSession(), kitConfig({ ui: UI, preview: { url } }));

    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["push-prototype-branch", "comment"]);
    expect(commentsOf(plan)[0]).toContain(
      "\n\nThere's no preview for prototypes: Kit config's `preview.url` names the pull request, as `{pr}`, and a prototype has none.\n\n**1. Which variant?**\n",
    );
  });

  it("links no preview, and says nothing of one, when Kit config declares no preview.url, as before", () => {
    const plan = planFor(finished(), inSession(), kitConfig({ ui: UI }));

    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["push-prototype-branch", "comment"]);
    expect(commentsOf(plan)[0]).not.toMatch(/preview/i);
  });

  it.each([
    ["whose build failed", finished({ capture: { ...CAPTURED, outcome: "failed", reason: "build-failed", captures: [] }, gallery: null })],
    ["whose dev server didn't start", finished({ capture: { ...CAPTURED, outcome: "failed", reason: "server-did-not-start", captures: [] }, gallery: null })],
    ["that changes a Trust-root file", finished({ changes: { net: [{ path: "AGENTS.md" }], commits: [{ path: "AGENTS.md" }] } })],
    ["that built nothing", finished({ changes: { net: [], commits: [] }, headSha: null })],
  ])("links none in the failure round of a prototype %s, which has no variant to open", (_name, event) => {
    const plan = planFor(event, inSession(), kitConfig({ ui: UI, preview: PREVIEW }));

    expect(plan.kind === "act" && plan.actions.some(({ kind }) => kind === "link-prototype-preview")).toBe(false);
    expect(commentsOf(plan)[0]).not.toMatch(/preview/i);
  });
});

describe("The trust-root guard on a prototype branch (ADR-0005)", () => {
  it("pushes nothing, and posts a prototype failure round naming every Trust-root path, even one a later commit undid", () => {
    const changes = {
      net: [{ path: "src/pages/book/Stepper.tsx" }],
      commits: [{ path: "src/pages/book/Stepper.tsx" }, { path: "AGENTS.md" }, { path: "src/App.tsx", from: ".github/workflows/ci.yml" }],
    };

    const plan = planFor(finished({ changes }), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-round 3 -->",
            "<!-- fabrik:prototype-failed -->",
            "@jrey **Design session, round 3: the prototype failed.** Reply with how you'd go on, or `yes` to take the recommendation.",
            "",
            "The prototype turn's branch for #7 changes files that steer or judge the agents, so the Kit didn't push it (ADR-0005):",
            "",
            "- `AGENTS.md`",
            "- `.github/workflows/ci.yml`",
            "",
            `Only the Operator changes these. [The run](${RUN}) has what the turn did.`,
            "",
            "**1. Carry on without a prototype, or try again?**",
            "➡️ Recommended: Carry on without a prototype. Trying again spends another prototype turn's Sandbox time, and may fail the same way.",
          ].join("\n"),
        },
      ],
    });
  });

  it("refuses before anything else is said of the branch, even when its build failed", () => {
    const plan = planFor(
      finished({ changes: { net: [{ path: "CLAUDE.md" }], commits: [{ path: "CLAUDE.md" }] }, capture: { ...CAPTURED, outcome: "failed", reason: "build-failed", captures: [] } }),
      inSession(),
      kitConfig(),
    );

    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["comment"]);
    expect(commentsOf(plan)[0]).toContain("so the Kit didn't push it (ADR-0005):\n\n- `CLAUDE.md`\n");
  });
});

describe("Landing a prototype turn that made no commit", () => {
  it("pushes nothing, and posts a prototype failure round saying nothing was built", () => {
    const plan = planFor(finished({ changes: { net: [], commits: [] }, headSha: null, capture: undefined, gallery: null }), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-round 3 -->",
            "<!-- fabrik:prototype-failed -->",
            "@jrey **Design session, round 3: the prototype failed.** Reply with how you'd go on, or `yes` to take the recommendation.",
            "",
            `The prototype turn on #7 built nothing: its branch has no change of its own, so the Kit pushed nothing and there's nothing to look at. [The run](${RUN}) has what the turn did.`,
            "",
            "**1. Carry on without a prototype, or try again?**",
            "➡️ Recommended: Carry on without a prototype. Trying again spends another prototype turn's Sandbox time, and may fail the same way.",
          ].join("\n"),
        },
      ],
    });
  });

  it("counts commits that undo each other as building nothing", () => {
    const plan = planFor(finished({ changes: { net: [], commits: [{ path: "src/pages/book/Stepper.tsx" }] } }), inSession(), kitConfig());

    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["comment"]);
    expect(commentsOf(plan)[0]).toContain("The prototype turn on #7 built nothing:");
  });
});

describe("The Operator's reply that approved the prototype", () => {
  it("deleted, the prototype turn posts nothing and pushes nothing, as any turn whose reply was deleted", () => {
    const plan = planFor(finished(), inSession({}, { startingComment: { id: 9001, exists: false } }), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "The Operator's reply that approved the prototype on #7 (comment 9001) was deleted, so the prototype turn posts nothing",
    });
  });

  it("fails the run when the push job didn't check it is still there", () => {
    const plan = planFor(finished(), inSession({}, { startingComment: null }), kitConfig());

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The prototype turn on #7 answers a reply (comment 9001) the push job didn't check is still there",
    });
  });

  it("needs no check when agent:design started the turn that asked for the prototype, which no reply did", () => {
    const request = { ...REQUEST, reply: null };

    const plan = planFor(finished({ request }), inSession({ pendingPrototype: request }, { startingComment: null }), kitConfig());

    expect(plan.kind === "act" && plan.actions.map(({ kind }) => kind)).toEqual(["push-prototype-branch", "comment"]);
  });
});

/** The Design-session turn's failure notice for the prototype turn on #7, saying how it failed. */
const failureNoticeSaying = (how: string) =>
  [
    "<!-- fabrik:design-turn-failed -->",
    `@jrey The prototype turn on #7 failed: ${how}.`,
    "",
    "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Reply on this issue to carry the session on: the turn your reply starts can ask for the prototype again.",
    "",
    `[The run](${RUN})`,
  ].join("\n");

/** #7's request, as the App posted it, then what the plan posted after it. */
const requestThen = (plan: Plan) =>
  [`<!-- fabrik:prototype-request ${JSON.stringify({ ...REQUEST.request, reply: REQUEST.reply })} -->\n**Prototype requested.** …`, ...commentsOf(plan)].map((body) => ({
    body,
    byApp: true,
  }));

describe("A prototype turn's output that breaks its contract", () => {
  it.each([
    ["an ordinary round", { kind: "round", intro: "Where we are.", questions: [{ question: "Which?", recommendation: "This." }] }, 'a prototype turn ends only in a prototype-round, not "round"'],
    ["a session outcome", { kind: "not-planned", comment: "Not building it." }, 'a prototype turn ends only in a prototype-round, not "not-planned"'],
    ["another prototype request", { kind: "prototype", route: "/book", variants: 3, brief: "Again.", comment: "Again." }, 'a prototype turn ends only in a prototype-round, not "prototype"'],
    ["a prototype-round of one variant", { ...ROUND, variants: [ROUND.variants[0]] }, "a prototype-round needs from 2 to 5 variants"],
  ])("pushes nothing, and posts the Design-session turn's failure notice on %s, which ends the pending request", (_name, output, error) => {
    const plan = planFor(finished({ output: JSON.stringify(output) }), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [{ kind: "comment", issue: 7, body: failureNoticeSaying(`its output broke the prototype turn's output contract (${error})`) }],
    });
    expect(pendingPrototypeIn(requestThen(plan))).toBeNull();
  });

  it("names the broken contract on one line that mentions nobody, though the output it quotes holds a mention", () => {
    const plan = planFor(finished({ output: JSON.stringify({ kind: "@jrey\nlook" }) }), inSession(), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual(["mention on #7"]);
    expect(commentsOf(plan)[0]?.split("\n")[1]).toMatch(/^@jrey The prototype turn on #7 failed: its output broke the prototype turn's output contract \(.*\)\.$/);
  });

  it("posts nothing when the session no longer waits on it, as any result it doesn't", () => {
    const output = JSON.stringify({ kind: "not-planned", comment: "Not building it." });

    expect(planFor(finished({ output }), inSession({ open: false }), kitConfig())).toEqual({ kind: "nothing", reason: "#7 is closed" });
  });
});

describe("A prototype turn's branch that isn't its issue's prototype branch", () => {
  it.each(["prototype/8", "fabrik/ticket-7", "main"])("pushes nothing on %s, and posts the Design-session turn's failure notice", (branch) => {
    expect(planFor(finished({ branch }), inSession(), kitConfig())).toEqual({
      kind: "act",
      actions: [{ kind: "comment", issue: 7, body: failureNoticeSaying(`it built \`${branch}\`, which isn't #7's prototype branch, prototype/7`) }],
    });
  });
});

describe("A prototype branch that moved while its turn ran, as a live Design session's push may move it", () => {
  const OTHER = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
  const BASE = "1f2e3d4c5b6a79880716253443526170f8e9d0c1";

  it.each([
    ["moved on", { from: BASE, to: OTHER }, "`prototype/7` moved from 1f2e3d4 to 0a1b2c3 while it ran"],
    ["was pushed when the turn cut it afresh", { from: null, to: OTHER }, "`prototype/7` was pushed, at 0a1b2c3, while it ran, though the turn cut it afresh"],
    ["was deleted", { from: BASE, to: null }, "`prototype/7` was deleted while it ran"],
  ])("pushes nothing when it %s, and posts the Design-session turn's failure notice, which ends the pending request", (_name, moved, said) => {
    const plan = planFor(finished({ changes: { ...finished().changes, moved }, headSha: null }), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: failureNoticeSaying(`${said}, and the Kit only ever fast-forwards a prototype branch from the head its turn started on, so it pushed nothing`),
        },
      ],
    });
    expect(pendingPrototypeIn(requestThen(plan))).toBeNull();
  });
});

describe("A prototype turn's result the session no longer waits on", () => {
  it.each([
    ["#7 is closed", { open: false }],
    ["#7 no longer has needs-design", { labels: ["enhancement"] }],
  ])("posts and pushes nothing when %s", (reason, issue) => {
    expect(planFor(finished(), inSession(issue), kitConfig())).toEqual({ kind: "nothing", reason });
  });

  // The Kit job routes on any bot's request marker; the push job, which knows the App's login, reads only the App's (src/github/snapshot.ts's byAppOf).
  it.each([
    ["the session has no pending request: another bot's look-alike started it, or a round already answered it", null],
    ["the session's pending request is another one", { ...REQUEST, request: { ...REQUEST.request, route: "/checkout" } }],
    ["the session's pending request names another reply", { ...REQUEST, reply: 9002 }],
  ])("drops the result as stale, changing nothing, when %s", (_name, pendingPrototype) => {
    expect(planFor(finished(), inSession({ pendingPrototype }), kitConfig())).toEqual({
      kind: "nothing",
      reason: "#7's Design session isn't waiting on the prototype request this turn built, so its result is stale",
    });
  });
});

describe("The Design session after a prototype round", () => {
  /** The session's comments, oldest first, as the push job reads them: rounds 1 and 2, the request, then what the landing posted. */
  const threadAfter = (plan: Plan) => [
    { body: "<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.** …", byBot: true, byApp: true },
    { body: "<!-- fabrik:design-round 2 -->\n@jrey **Design session, round 2.** …", byBot: true, byApp: true },
    { body: `<!-- fabrik:prototype-request ${JSON.stringify({ ...REQUEST.request, reply: REQUEST.reply })} -->\n**Prototype requested.** …`, byBot: true, byApp: true },
    { body: "Yes, prototype it.", byBot: false, byApp: false },
    ...commentsOf(plan).map((body) => ({ body, byBot: true, byApp: true })),
  ];

  it.each([
    ["a prototype round", finished()],
    ["a capture-failed prototype round", finished({ capture: { ...CAPTURED, outcome: "failed", reason: "timeout", captures: [] }, gallery: null })],
    ["a build-failed prototype failure round", finished({ capture: { ...CAPTURED, outcome: "failed", reason: "build-failed", captures: [] }, gallery: null })],
    ["a trust-root refusal", finished({ changes: { net: [{ path: "AGENTS.md" }], commits: [{ path: "AGENTS.md" }] } })],
    ["an empty branch's failure round", finished({ changes: { net: [], commits: [] }, headSha: null })],
  ])("counts %s as its round 3, ending the pending request without failing the turn", (_name, event) => {
    const thread = threadAfter(planFor(event, inSession(), kitConfig()));

    expect(designSessionOf(thread).designRounds).toBe(3);
    expect(pendingPrototypeIn(thread)).toBeNull();
    expect(designTurnFailedIn(thread)).toBe(false);
  });

  it.each([
    ["prototype round", finished()],
    ["prototype failure round", finished({ capture: { ...CAPTURED, outcome: "failed", reason: "server-did-not-start", captures: [] }, gallery: null })],
  ])("starts an ordinary turn on the Operator's reply to its %s, as on any round's", (_name, event) => {
    const thread = threadAfter(planFor(event, inSession(), kitConfig()));
    const after = anIssue({
      number: 7,
      labels: ["enhancement", "needs-design"],
      ...designSessionOf(thread),
      pendingPrototype: pendingPrototypeIn(thread),
    });
    const reply = { kind: "issue-comment-created", issue: 7, commenter: "jrey", commenterIsBot: false, body: "B, with C's calendar.", comment: 9100 } as const;

    expect(planFor(reply, snapshotOf(after, { operator: "jrey" }), kitConfig({ ui: UI }))).toEqual({
      kind: "act",
      actions: [
        { kind: "start-agent-run", role: "design", issue: 7, model: DESIGN.model, effort: DESIGN.effort, timeoutMinutes: DESIGN.timeoutMinutes, subscription: DEFAULT_KIT_CONFIG.subscriptions[0] },
      ],
    });
  });
});

describe("A failed prototype turn", () => {
  /** The prototype job on #7, failed or cancelled, as the push job reads it: an Infrastructure failure of a Design-session turn. */
  const failedTurn = (overrides: Partial<Extract<LoopEvent, { kind: "agent-run-failed" }>> = {}): LoopEvent => ({
    kind: "agent-run-failed",
    role: "design",
    prototype: true,
    issue: 7,
    runUrl: RUN,
    jobResult: "cancelled",
    secretsStep: "success",
    report: null,
    ...overrides,
  });

  it("posts the Design-session turn's failure notice, named for the prototype turn and its own timeout, the Implement role's, and says a reply carries the session on", () => {
    const plan = planFor(failedTurn(), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-turn-failed -->",
            `@jrey The prototype turn on #7 failed: it was cancelled, most likely by its ${DEFAULT_KIT_CONFIG.roles.implement.timeoutMinutes}-minute timeout.`,
            "",
            "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Reply on this issue to carry the session on: the turn your reply starts can ask for the prototype again.",
            "",
            `[The run](${RUN})`,
          ].join("\n"),
        },
      ],
    });
  });

  it("ends the pending request, so the Operator's reply starts an ordinary turn", () => {
    const [notice = ""] = commentsOf(planFor(failedTurn({ jobResult: "failure" }), inSession(), kitConfig()));
    const request = `<!-- fabrik:prototype-request ${JSON.stringify({ ...REQUEST.request, reply: REQUEST.reply })} -->\n**Prototype requested.** …`;

    expect(pendingPrototypeIn([request, notice].map((body) => ({ body, byApp: true })))).toBeNull();
  });
});
