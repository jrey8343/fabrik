import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { prototypeRequestIn } from "./markers.ts";
import { planFor } from "./rules.ts";
import type { Plan } from "./types.ts";

function commentsOf(plan: Plan): string[] {
  if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
  return plan.actions.flatMap((action) => (action.kind === "comment" ? [action.body] : []));
}

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const inSession = snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 1 }), { operator: "jrey" });

const requested = {
  kind: "prototype",
  route: "/book",
  variants: 3,
  brief: "- **A**: one long form.\n- **B**: a stepper.\n- **C**: a calendar first.",
  comment: "Prototyping the booking page as you approved.",
};

/** Prototypes as they will be once switched on (#282); only these tests pass it. */
const switchedOn = { prototypes: true } as const;

describe("An ordinary Design turn that asks for the Prototype the Operator approved", () => {
  it("posts the prototype request with its marker, mentioning nobody, then adds agent:design to start the prototype turn", () => {
    const plan = planFor(turnFinished(requested), inSession, kitConfig({ ui: UI }), switchedOn);

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            String.raw`<!-- fabrik:prototype-request {"route":"/book","variants":3,"brief":"- **A**: one long form.\n- **B**: a stepper.\n- **C**: a calendar first."} -->`,
            "**Prototype requested.** Prototyping the booking page as you approved.",
            "",
            "The Kit is building 3 variants of `/book`. The prototype round follows when they're ready.",
          ].join("\n"),
        },
        { kind: "add-labels", issue: 7, labels: ["agent:design"] },
      ],
    });
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("leaves a marker that reads back as the request, whatever the brief holds, an HTML comment's end included", () => {
    const brief = "- **A**: a form -->\n- **B**: <Stepper /> & a calendar, for @jrey";
    const plan = planFor(turnFinished({ ...requested, variants: 2, brief }), inSession, kitConfig({ ui: UI }), switchedOn);

    const [body] = commentsOf(plan);

    expect(prototypeRequestIn(body ?? "")).toEqual({ route: "/book", variants: 2, brief });
    expect(body?.split("\n")[0]?.match(/-->/g)).toEqual(["-->"]);
    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it.each([
    ["quoted after the comment's first line", (marker: string) => `Look at this:\n${marker}`],
    ["holding a route that isn't one", () => '<!-- fabrik:prototype-request {"route":"book","variants":3,"brief":"B"} -->'],
    ["holding more variants than the cap", () => '<!-- fabrik:prototype-request {"route":"/book","variants":6,"brief":"B"} -->'],
    ["holding no brief", () => '<!-- fabrik:prototype-request {"route":"/book","variants":3,"brief":""} -->'],
    ["holding broken JSON", () => '<!-- fabrik:prototype-request {"route":"/book", -->'],
  ])("reads no request from a marker %s", (_, comment) => {
    const [body] = commentsOf(planFor(turnFinished(requested), inSession, kitConfig({ ui: UI }), switchedOn));
    const marker = body?.split("\n")[0] ?? "";

    expect(prototypeRequestIn(comment(marker))).toBeNull();
  });
});

describe("A Design turn that asks for a Prototype on a Product repo with no ui block", () => {
  it("fails as a broken contract and posts nothing: the Kit can't serve or capture one", () => {
    const plan = planFor(turnFinished(requested), inSession, kitConfig({ ui: null }), switchedOn);

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The Design-session turn on #7 emitted output that breaks its contract: this Product repo's Kit config has no `ui` block, so the Kit can't serve or capture a Prototype",
    });
  });
});

describe("A Design turn that asks for a Prototype while Prototypes are off", () => {
  it("fails as a broken contract and posts nothing, even with a ui block", () => {
    const plan = planFor(turnFinished(requested), inSession, kitConfig({ ui: UI }));

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The Design-session turn on #7 emitted output that breaks its contract: Prototypes are off in this Kit, so a turn can't ask for one",
    });
  });
});

describe("An ordinary Design turn that ends in a prototype round", () => {
  it.each([
    ["while Prototypes are off", kitConfig(), {}],
    ["with Prototypes switched on and a ui block", kitConfig({ ui: UI }), switchedOn],
  ])("fails as a broken contract and posts nothing %s: only a prototype turn builds variants", (_, config, options) => {
    const built = {
      kind: "prototype-round",
      intro: "Two takes on `/book`.",
      variants: [
        { summary: "One long form.", component: "src/routes/book/VariantA.tsx" },
        { summary: "A stepper.", component: "src/routes/book/VariantB.tsx" },
      ],
      recommendation: "B",
    };

    const plan = planFor(turnFinished(built), inSession, config, options);

    expect(plan).toEqual({
      kind: "fail",
      failure: "infrastructure",
      reason: "The Design-session turn on #7 emitted output that breaks its contract: only a prototype turn ends in a prototype-round, and this was an ordinary turn",
    });
  });
});
