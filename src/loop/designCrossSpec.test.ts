import { describe, expect, it } from "vitest";
import { readDesignTurnOutput } from "./designOutput.ts";

// A Design session that sees the open Tickets under other Specs (#825) may make a Ticket wait on one of them by its
// number. An Operator step whose job was to open a new issue gave that issue as `newIssue`, which went when the
// Kit began to open a Spin-off itself (#883).
const ticket = (key: string, blockedBy: (string | number)[] = [], extra: Record<string, unknown> = {}) => ({
  key,
  title: `Waitlist: ${key}`,
  body: `## What to build\n\nThe ${key} slice.`,
  blockedBy,
  ...extra,
});

const operatorStep = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Waitlist: ${key}`,
  body: "The reminders need the SMS provider's secret.",
  blockedBy: [],
  operator: true,
  steps: ["Add the SMS secret", "Check a test message arrives"],
  ...extra,
});

const spec = (tickets: unknown[]) => ({
  kind: "spec",
  comment: "Builds on #482's model.",
  spec: { title: "Spec: Waitlist", body: "## Problem Statement\n\nFully booked days lose patients." },
  tickets,
});

describe("A Design output's cross-Spec blockedBy", () => {
  it("takes the number of an open Ticket the turn was given beside its sibling keys", () => {
    const result = readDesignTurnOutput(spec([ticket("model"), ticket("ui", ["model", 482])]), 7, [482, 490]);

    expect(result).toMatchObject({ ok: true, output: { tickets: [{ key: "model" }, { key: "ui", blockedBy: ["model", 482] }] } });
  });

  it("refuses a number that isn't an open Ticket the turn was given, naming it", () => {
    const result = readDesignTurnOutput(spec([ticket("ui", [481])]), 7, [482]);

    expect(result).toEqual({
      ok: false,
      errors: ['ticket "ui" is blocked by #481, which isn\'t one of "The open Tickets" this turn was given'],
    });
  });

  it("refuses a number that isn't an issue's", () => {
    expect(readDesignTurnOutput(spec([ticket("ui", [0])]), 7, [])).toMatchObject({ ok: false });
    expect(readDesignTurnOutput(spec([ticket("ui", [4.5])]), 7, [])).toMatchObject({ ok: false });
  });

  it("takes any issue's number on the push job's side, which wasn't given the list", () => {
    expect(readDesignTurnOutput(spec([ticket("ui", [481])]), 7)).toMatchObject({ ok: true });
  });

  it("works in a split as in a Spec", () => {
    const split = { kind: "split", comment: "Split.", tickets: [ticket("ui", [482])] };

    expect(readDesignTurnOutput(split, 7, [482])).toMatchObject({ ok: true, output: { tickets: [{ blockedBy: [482] }] } });
  });

  it("never lets a Decision wait on an issue by number", () => {
    const map = {
      kind: "map",
      comment: "Foggy.",
      destination: "Patients can join a waitlist.",
      notes: "",
      notYetSpecified: "",
      outOfScope: "",
      decisions: [{ key: "provider", title: "Which SMS provider?", body: "## Question", type: "research", blockedBy: [482] }],
    };

    expect(readDesignTurnOutput(map, 7, [482])).toMatchObject({ ok: false });
  });
});

describe("A Design output's newIssue, which the Kit no longer takes (#883)", () => {
  it.each([{ title: "Remind waitlisted patients", body: "Text them a day before." }, { title: "" }, "Remind them", null])(
    "refuses an Operator step that carries one, naming spinOffs: %j",
    (newIssue) => {
      expect(readDesignTurnOutput(spec([ticket("model"), operatorStep("reminders", { newIssue })]), 7, [])).toEqual({
        ok: false,
        errors: ['operator step "reminders" has newIssue, which an Operator step no longer carries: write the issue as a Spin-off in spinOffs, and the Kit opens it'],
      });
    },
  );

  it("refuses a Ticket that carries one, naming spinOffs", () => {
    expect(readDesignTurnOutput(spec([ticket("model", [], { newIssue: { title: "x", body: "y" } })]), 7, [])).toEqual({
      ok: false,
      errors: ['ticket "model" has newIssue, which no Ticket carries: write the issue as a Spin-off in spinOffs, and the Kit opens it'],
    });
  });

  it("refuses one in a split as in a Spec", () => {
    const split = { kind: "split", comment: "Split.", tickets: [operatorStep("reminders", { newIssue: { title: "x", body: "y" } })] };

    expect(readDesignTurnOutput(split, 7, [])).toMatchObject({ ok: false, errors: [expect.stringContaining("spinOffs")] });
  });
});
