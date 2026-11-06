import { describe, expect, it } from "vitest";
import { parseDesignTurnOutput } from "./designOutput.ts";

const turn = (value: unknown) => parseDesignTurnOutput(JSON.stringify(value));

const requested = {
  kind: "prototype",
  route: "/book",
  variants: 3,
  brief: "- **A**: one long form, everything on one page.\n- **B**: a stepper, one question at a time.\n- **C**: a calendar first, details after.\n\nThe Operator asked for a bigger booking button in every variant.",
  comment: "Prototyping the booking page as you approved.",
};

describe("A Design turn's prototype output: the Operator approved a Prototype", () => {
  it("reads the route, the variant count, the brief and the request comment's lead-in", () => {
    expect(turn(requested)).toEqual({ ok: true, output: requested });
  });
});
