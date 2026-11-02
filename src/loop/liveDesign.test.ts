import { describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { planFor } from "./rules.ts";

// A live Design session runs in a cloud or local session with the Operator's own
// credentials. It publishes the Spec and Tickets (or rewrites the issue as its
// agent brief) itself, then posts one outcome comment, which the Kit lands.
const commented = (body: string, commenter = "jrey", commenterIsBot = false) =>
  ({ kind: "issue-comment-created", issue: 7, commenter, commenterIsBot, body }) as const;

const inSession = (labels: readonly string[] = ["enhancement", "needs-design"], open = true) =>
  snapshotOf(anIssue({ number: 7, labels, open }), { operator: "jrey" });

describe("Landing a live Design session's outcome", () => {
  it("makes the issue ready for an Implementer when the live session ended with an agent brief", () => {
    const plan = planFor(
      commented("<!-- fabrik:live-outcome brief -->\n**Design session finished live.** This issue is now its agent brief."),
      inSession(),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "add-labels", issue: 7, labels: ["ready-for-agent"] },
        { kind: "check-dispatch" },
      ],
    });
  });

  it("closes the issue and runs Dispatch on the new Tickets when the live session ended with a Spec", () => {
    const plan = planFor(
      commented("<!-- fabrik:live-outcome spec -->\n**Design session finished live.** Superseded by the Spec #12."),
      inSession(),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "act",
      actions: [
        { kind: "remove-label", issue: 7, label: "needs-design" },
        { kind: "close", issue: 7, reason: "completed" },
        { kind: "check-dispatch" },
      ],
    });
  });

  it("does not start an async turn for the outcome comment", () => {
    const plan = planFor(commented("<!-- fabrik:live-outcome brief -->\nDone."), inSession(), kitConfig());

    expect(plan.kind === "act" && plan.actions.some((action) => action.kind === "start-agent-run")).toBe(false);
  });

  it("ignores an outcome marker from anyone but the Operator, saying why", () => {
    const plan = planFor(commented("<!-- fabrik:live-outcome brief -->\nDone.", "someone"), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "@someone isn't the Operator, so their comment on #7 doesn't drive the Design session",
    });
  });

  it("ignores an outcome marker from a bot, saying why", () => {
    const plan = planFor(
      commented("<!-- fabrik:live-outcome spec -->\nDone.", "fabrik-app[bot]", true),
      inSession(),
      kitConfig(),
    );

    expect(plan).toEqual({
      kind: "nothing",
      reason: "@fabrik-app[bot] is a bot, so its comment on #7 doesn't drive the Loop",
    });
  });

  it("refuses an outcome it doesn't know, rather than taking it as an answer, saying why", () => {
    const plan = planFor(commented("<!-- fabrik:live-outcome paused -->\nLater."), inSession(), kitConfig());

    expect(plan).toEqual({
      kind: "nothing",
      reason: "The live Design session on #7 posted the outcome paused, which isn't brief or spec, so the Kit left the issue as it is",
    });
  });

  it("only counts the marker at the start of the comment, so a quoted one is an ordinary answer", () => {
    const plan = planFor(
      commented("Earlier I posted `<!-- fabrik:live-outcome brief -->` by mistake; carry on."),
      inSession(),
      kitConfig(),
    );

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "design", issue: 7 }] });
  });

  it("does nothing when the issue already left the session, saying why", () => {
    const plan = planFor(
      commented("<!-- fabrik:live-outcome spec -->\nDone."),
      inSession(["enhancement", "needs-design"], false),
      kitConfig(),
    );

    expect(plan).toEqual({ kind: "nothing", reason: "#7 is closed" });
  });

  it("treats a live session that stops before finishing as an ordinary answer, so the async session carries on", () => {
    const plan = planFor(
      commented("Live session notes: settled 1-3, still open: pricing."),
      inSession(),
      kitConfig(),
    );

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "design", issue: 7 }] });
  });
});
