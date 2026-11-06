import { describe, expect, it } from "vitest";
import { readReplayRequest } from "./replay.ts";

/** A Fabrik commit with a prompt change to try. */
const CANDIDATE = "0123456789abcdef0123456789abcdef01234567";

/** A replay issue's body: a line of the Operator's own, then the request block holding `lines`. */
function bodyWith(...lines: string[]): string {
  return ["Does Review hold up at a higher effort?", "", "```replay", ...lines, "```", ""].join("\n");
}

describe("Reading a replay request", () => {
  it("reads a role's effort as the variable, with the default pick of Tickets", () => {
    expect(readReplayRequest(bodyWith("review.effort: high"))).toEqual({
      ok: true,
      request: { variable: { kind: "effort", role: "review", effort: "high" }, tickets: null },
    });
  });

  it.each([
    ["implement.model: claude-opus-5-5", { kind: "model", role: "implement", model: "claude-opus-5-5" }],
    ["implement.effort: max", { kind: "effort", role: "implement", effort: "max" }],
    ["review.model: claude-sonnet-5-5", { kind: "model", role: "review", model: "claude-sonnet-5-5" }],
    ["review.effort: low", { kind: "effort", role: "review", effort: "low" }],
    [`kit: ${CANDIDATE}`, { kind: "kit", sha: CANDIDATE }],
  ])("reads %j as its variable", (line, variable) => {
    expect(readReplayRequest(bodyWith(line))).toEqual({ ok: true, request: { variable, tickets: null } });
  });

  it("reads the Tickets the Operator listed, in their order, with or without a #", () => {
    expect(readReplayRequest(bodyWith("tickets: #41, 12 #7", "review.effort: high"))).toEqual({
      ok: true,
      request: { variable: { kind: "effort", role: "review", effort: "high" }, tickets: [41, 12, 7] },
    });
  });

  describe("finds the request in the body's one replay block", () => {
    it("refuses a body with no replay block", () => {
      expect(readReplayRequest("Try Review at a higher effort.\n\n```\nreview.effort: high\n```\n")).toEqual({
        ok: false,
        errors: ["the body has no ```replay block: put the request in one, naming one variable, such as review.effort: high"],
      });
    });

    it("refuses a body with two, since which one is the request is unclear", () => {
      expect(readReplayRequest(`${bodyWith("review.effort: high")}\n${bodyWith("review.effort: low")}`)).toEqual({
        ok: false,
        errors: ["the body has 2 ```replay blocks, but a request is one"],
      });
    });

    it("refuses a block that's never closed", () => {
      expect(readReplayRequest("```replay\nreview.effort: high\n")).toEqual({
        ok: false,
        errors: ["the ```replay block is never closed with ```"],
      });
    });

    it("reads a body GitHub saved with Windows line endings", () => {
      expect(readReplayRequest(bodyWith("tickets: 3, 4", "review.effort: high").replaceAll("\n", "\r\n"))).toEqual({
        ok: true,
        request: { variable: { kind: "effort", role: "review", effort: "high" }, tickets: [3, 4] },
      });
    });

    it("skips blank lines in the block", () => {
      expect(readReplayRequest(bodyWith("", "review.effort: high", "  "))).toEqual({
        ok: true,
        request: { variable: { kind: "effort", role: "review", effort: "high" }, tickets: null },
      });
    });
  });

  describe("takes up to 10 listed Tickets", () => {
    const listing = (count: number) => `tickets: ${Array.from({ length: count }, (_, i) => `#${101 + i}`).join(", ")}`;

    it("takes 10", () => {
      const read = readReplayRequest(bodyWith("kit: " + CANDIDATE, listing(10)));

      expect(read.ok && read.request.tickets).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    });

    it("refuses 11", () => {
      expect(readReplayRequest(bodyWith("kit: " + CANDIDATE, listing(11)))).toEqual({
        ok: false,
        errors: ["tickets lists 11 Tickets, but a replay takes at most 10"],
      });
    });

    it.each([
      ["something that isn't a Ticket number", "tickets: 12, twelve", `tickets lists "twelve", which isn't a Ticket number`],
      ["a zero", "tickets: #0", `tickets lists "#0", which isn't a Ticket number`],
      ["a Ticket twice", "tickets: 12, 15, #12", "tickets lists #12 twice"],
    ])("refuses a list with %s", (_, line, error) => {
      expect(readReplayRequest(bodyWith("review.effort: high", line))).toEqual({ ok: false, errors: [error] });
    });
  });

  it.each([
    ["the variable", "review.effort: low", "review.effort is given twice"],
    ["the Tickets", "tickets: 5", "tickets is given twice"],
  ])("refuses %s given twice", (_, line, error) => {
    expect(readReplayRequest(bodyWith("review.effort: high", "tickets: 4", line))).toEqual({ ok: false, errors: [error] });
  });

  it("says every way a request is invalid at once", () => {
    const read = readReplayRequest(bodyWith("review.model: best", "implement.effort: extreme", "tickets: 1 2 3 4 5 6 7 8 9 10 11"));

    expect(read).toEqual({
      ok: false,
      errors: [
        `review.model is "best": Fable can bill metered usage, so the Kit never runs it in an AFK role`,
        `implement.effort is "extreme": effort must be one of low, medium, high, xhigh, max`,
        "tickets lists 11 Tickets, but a replay takes at most 10",
        "the request names 2 variables, review.model and implement.effort, but a replay changes exactly one",
      ],
    });
  });

  describe("refuses a request that doesn't name exactly one variable", () => {
    it("refuses one naming none", () => {
      expect(readReplayRequest(bodyWith("tickets: 12"))).toEqual({
        ok: false,
        errors: ["the request names no variable: give one of implement.model, implement.effort, review.model, review.effort or kit"],
      });
    });

    it("refuses one naming two, and names both", () => {
      expect(readReplayRequest(bodyWith("implement.model: claude-opus-5-5", "review.effort: high"))).toEqual({
        ok: false,
        errors: ["the request names 2 variables, implement.model and review.effort, but a replay changes exactly one"],
      });
    });
  });

  it.each([
    ["design.model: claude-opus-5-5", "design.model names the design role, but a replay changes only implement or review"],
    ["triage.effort: high", "triage.effort names the triage role, but a replay changes only implement or review"],
  ])("refuses %j, a role a replay doesn't run", (line, error) => {
    expect(readReplayRequest(bodyWith(line))).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    ["implement.timeout_minutes: 90", "implement.timeout_minutes isn't a request field: give implement.model, implement.effort, review.model, review.effort or kit, and tickets if you like"],
    ["sha: " + CANDIDATE, "sha isn't a request field: give implement.model, implement.effort, review.model, review.effort or kit, and tickets if you like"],
  ])("refuses %j, a field a request doesn't have", (line, error) => {
    expect(readReplayRequest(bodyWith(line, "review.effort: high"))).toEqual({ ok: false, errors: [error] });
  });

  it.each([
    ["a line with no colon", "review.effort high", `"review.effort high" isn't a field: write each one as name: value`],
    ["a field with no value", "review.effort:", "review.effort has no value"],
  ])("refuses %s", (_, line, error) => {
    expect(readReplayRequest(bodyWith(line, "tickets: 4"))).toEqual({ ok: false, errors: [error] });
  });

  describe("refuses a model the Kit never runs", () => {
    it.each(["fable", "claude-fable-5", "best"])("refuses %j with Kit config's reason", (model) => {
      expect(readReplayRequest(bodyWith(`implement.model: ${model}`))).toEqual({
        ok: false,
        errors: [`implement.model is ${JSON.stringify(model)}: Fable can bill metered usage, so the Kit never runs it in an AFK role`],
      });
    });

    it.each(["gpt-5", "gemini-3-pro", "sonnet"])("refuses %j, which isn't a Claude model named in full", (model) => {
      expect(readReplayRequest(bodyWith(`review.model: ${model}`))).toEqual({
        ok: false,
        errors: [`review.model is ${JSON.stringify(model)}: a replay runs only a Claude model, named in full, such as claude-sonnet-5-5`],
      });
    });
  });

  it.each(["extreme", "High", "none"])("refuses %j as an effort, with Kit config's reason", (effort) => {
    expect(readReplayRequest(bodyWith(`review.effort: ${effort}`))).toEqual({
      ok: false,
      errors: [`review.effort is ${JSON.stringify(effort)}: effort must be one of low, medium, high, xhigh, max`],
    });
  });

  it.each([
    ["a short sha", "0123456"],
    ["a sha one character short", CANDIDATE.slice(1)],
    ["an uppercase sha", CANDIDATE.toUpperCase()],
    ["a branch name", "retro/prompt-change"],
  ])("refuses %s as the candidate Kit", (_, sha) => {
    expect(readReplayRequest(bodyWith(`kit: ${sha}`))).toEqual({
      ok: false,
      errors: [`kit is ${JSON.stringify(sha)}: a candidate Kit must be a Fabrik commit's full 40-character lowercase SHA`],
    });
  });
});
