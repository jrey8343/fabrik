import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, notificationsOf, snapshotOf } from "../__fixtures__/snapshots.ts";
import { DEFAULT_KIT_CONFIG } from "../kit/config.ts";
import { planFor } from "./rules.ts";

const charted = {
  kind: "map",
  comment: "Too foggy for one session, so it's a Map.",
  destination: "Patients book group classes online.",
  notes: "",
  notYetSpecified: "",
  outOfScope: "",
  decisions: [{ key: "provider", title: "Which provider?", body: "## Question\n\nWhich one?", type: "research", blockedBy: [] }],
};

const turnFinished = (output: unknown) =>
  ({ kind: "agent-run-finished", role: "design", issue: 7, output: JSON.stringify(output) }) as const;

const inSession = (openMaps: readonly number[] | null) =>
  snapshotOf(anIssue({ number: 7, labels: ["enhancement", "needs-design"], designRounds: 1 }), { operator: "jrey", openMaps });

const capOf = (maps: number) => kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, maps } });

describe("The Map cap holding a Design session's Map", () => {
  it("refuses a Map while the open Maps meet the cap: the turn's one comment names the open Map, and the issue stays as it is", () => {
    const plan = planFor(turnFinished(charted), inSession([12]), kitConfig());

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-turn-failed -->",
            "This turn ended in a Map, but the Map cap is full: #12 is the open Map, and `caps.maps` is 1. The Kit left #7 as it is, and the Design session carries on: reply to finish it another way, or close #12 first and ask for the Map again.",
          ].join("\n"),
        },
      ],
    });
  });

  it("holds silently: the comment mentions no one and the plan assigns no one", () => {
    const plan = planFor(turnFinished(charted), inSession([12]), kitConfig());

    expect(notificationsOf(plan, "jrey")).toEqual([]);
  });

  it("names every open Map when more than the cap are open, as Maps made by hand can make them", () => {
    const plan = planFor(turnFinished(charted), inSession([12, 14]), kitConfig());

    expect(plan).toMatchObject({
      kind: "act",
      actions: [
        {
          kind: "comment",
          body: expect.stringContaining("the Map cap is full: #12 and #14 are the open Maps, and `caps.maps` is 1."),
        },
      ],
    });
  });

  it("refuses every Map when caps.maps is 0, with no Map open", () => {
    const plan = planFor(turnFinished(charted), inSession([]), capOf(0));

    expect(plan).toEqual({
      kind: "act",
      actions: [
        {
          kind: "comment",
          issue: 7,
          body: [
            "<!-- fabrik:design-turn-failed -->",
            "This turn ended in a Map, but `caps.maps` is 0, so the Kit charts no new Map in this repo. The Kit left #7 as it is, and the Design session carries on: reply to finish it another way.",
          ].join("\n"),
        },
      ],
    });
  });

  it("lets the Map land while the cap has room", () => {
    const plan = planFor(turnFinished(charted), inSession([]), kitConfig());

    expect(plan).toMatchObject({
      kind: "act",
      actions: expect.arrayContaining([{ kind: "add-labels", issue: 7, labels: ["wayfinder:map"] }]),
    });
  });

  it("fails, rather than guess, when the snapshot holds no open Maps", () => {
    const plan = planFor(turnFinished(charted), inSession(null), kitConfig());

    expect(plan).toEqual({ kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the open Maps" });
  });

  it("weighs only a Map: a round lands without the open Maps", () => {
    const round = { kind: "round", intro: "Where it stands.", questions: [{ question: "Which?", recommendation: "This one." }] };

    expect(planFor(turnFinished(round), inSession(null), capOf(0))).toMatchObject({ kind: "act", actions: [{ kind: "comment", issue: 7 }] });
  });
});
