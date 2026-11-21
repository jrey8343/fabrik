import { describe, expect, it } from "vitest";
import { readDesignTurnOutput } from "./designOutput.ts";

// A Design session that sees the open Tickets under other Specs (#825) may make a Ticket wait on one of them by its
// number, and an Operator step whose job is to open a new issue gives that issue's title and body as `newIssue`.
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
  body: "The reminders need their own issue.",
  blockedBy: [],
  operator: true,
  steps: ["Open the issue from the link above", "Label it enhancement"],
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

describe("A Design output's newIssue on an Operator step", () => {
  it("takes a title and a body on an Operator step", () => {
    const result = readDesignTurnOutput(spec([ticket("model"), operatorStep("reminders", { newIssue: { title: "Remind waitlisted patients", body: "Text them a day before." } })]), 7, []);

    expect(result).toMatchObject({
      ok: true,
      output: { tickets: [{ key: "model" }, { key: "reminders", operator: true, newIssue: { title: "Remind waitlisted patients", body: "Text them a day before." } }] },
    });
  });

  it.each([{ title: "" , body: "x" }, { title: "x" }, "Remind them"])("refuses a newIssue without a title and a body: %j", (newIssue) => {
    expect(readDesignTurnOutput(spec([operatorStep("reminders", { newIssue })]), 7, [])).toEqual({
      ok: false,
      errors: ['operator step "reminders" needs newIssue to have non-empty title and body text, if it has one'],
    });
  });

  it("refuses a newIssue on a Ticket, which an Implementer builds", () => {
    expect(readDesignTurnOutput(spec([ticket("model", [], { newIssue: { title: "x", body: "y" } })]), 7, [])).toEqual({
      ok: false,
      errors: ['ticket "model" has newIssue, but only an Operator step asks the Operator to open an issue: mark it "operator": true with its steps'],
    });
  });
});
