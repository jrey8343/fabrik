import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import type { CaptureResult } from "../evidence/uiEvidence.ts";
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
