import { describe, expect, it } from "vitest";
import { handBackMarker, handBackMarkIn } from "./markers.ts";

describe("the hand-back marker", () => {
  it("is one hidden line naming the hand-back, and the role and failure where it has them, read back as it was", () => {
    const marker = handBackMarker({ kind: "infrastructure-failure", role: "implement", failure: "timeout" });
    expect(marker).toBe('<!-- fabrik:hand-back {"kind":"infrastructure-failure","role":"implement","failure":"timeout"} -->');
    expect(handBackMarkIn(marker)).toEqual({ kind: "infrastructure-failure", role: "implement", failure: "timeout" });
  });

  it("names only the hand-back when that is all it has", () => {
    expect(handBackMarker({ kind: "closed-by-hand" })).toBe('<!-- fabrik:hand-back {"kind":"closed-by-hand"} -->');
    expect(handBackMarkIn(handBackMarker({ kind: "closed-by-hand" }))).toEqual({ kind: "closed-by-hand" });
  });

  it("is read on any line of a notice, as its last line is where the Kit puts it", () => {
    const body = ["<!-- fabrik:implement-run-failed -->", "@operator The Implement run on #7 failed: it crashed.", "", handBackMarker({ kind: "broken-run-no-retry", role: "implement", failure: "left-branch" })].join("\n");
    expect(handBackMarkIn(body)).toEqual({ kind: "broken-run-no-retry", role: "implement", failure: "left-branch" });
  });

  it("reads nothing from a notice without one, nor from a line naming no hand-back the Kit knows", () => {
    expect(handBackMarkIn("@operator The Implement run on #7 failed: it crashed.")).toBeNull();
    expect(handBackMarkIn('<!-- fabrik:hand-back {"kind":"gone-fishing"} -->')).toBeNull();
    expect(handBackMarkIn('<!-- fabrik:hand-back {"kind":"closed-by-hand","role":"juggler"} -->')).toBeNull();
    expect(handBackMarkIn("<!-- fabrik:hand-back {not json} -->")).toBeNull();
  });

  it("reads one quoted in a person's reply only as the line it is, never half a line", () => {
    expect(handBackMarkIn(`> ${handBackMarker({ kind: "closed-by-hand" })}`)).toBeNull();
  });
});
