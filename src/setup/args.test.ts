// The setup program's command line: each question has a flag, an empty value
// or a --no- form answers no, and anything else is refused with the usage line.
import { describe, expect, it } from "vitest";
import { parseSetupArgs, SETUP_USAGE } from "./args.ts";

function parsed(...args: string[]) {
  const result = parseSetupArgs([".", "v1.4.2", ...args]);
  if (!result.ok) throw new Error(result.error);
  return result.args;
}

function refused(...args: string[]): string {
  const result = parseSetupArgs(args);
  if (result.ok) throw new Error(`${args.join(" ")} was accepted`);
  return result.error;
}

describe("The setup program's flags", () => {
  it("takes the Product checkout and the release as its two arguments", () => {
    const args = parsed();

    expect(args.productDir).toBe(".");
    expect(args.release).toBe("v1.4.2");
    expect(args.plan).toBe(false);
  });

  it("leaves every question unanswered when no flag answers it", () => {
    expect(parsed().answers).toEqual({});
    expect(parsed().account).toBeUndefined();
  });

  it("answers each question yes with its flag", () => {
    expect(parsed("--time-zone=Europe/London", "--second-subscription", "--paused").answers).toEqual({
      timeZone: "Europe/London",
      secondSubscription: true,
      paused: true,
    });
  });

  it("answers each question no with its --no- form", () => {
    expect(parsed("--no-time-zone", "--no-second-subscription", "--no-paused").answers).toEqual({
      timeZone: null,
      secondSubscription: false,
      paused: false,
    });
  });

  it("answers each question no with an empty value", () => {
    expect(parsed("--time-zone=", "--second-subscription=", "--paused=").answers).toEqual({
      timeZone: null,
      secondSubscription: false,
      paused: false,
    });
  });

  it("takes the last of a flag given twice", () => {
    expect(parsed("--paused", "--no-paused", "--time-zone=Europe/London", "--time-zone=Asia/Tokyo").answers).toEqual({
      paused: false,
      timeZone: "Asia/Tokyo",
    });
  });

  it("takes the 1Password account from --account=", () => {
    expect(parsed("--account=acme.1password.com").account).toBe("acme.1password.com");
  });

  it("takes --plan", () => {
    expect(parsed("--plan").plan).toBe(true);
  });

  it("refuses --apply, which carried the plan out without the Operator's yes", () => {
    expect(refused(".", "v1.4.2", "--apply")).toBe("Unknown flag --apply.");
  });

  it("refuses the Visual evidence flags, which /fabrik-visual-evidence took over", () => {
    expect(refused(".", "v1.4.2", "--ui-path=src/pages/**")).toBe("Unknown flag --ui-path=src/pages/**.");
  });

  it("refuses a missing release", () => {
    expect(refused(".")).toContain("needs the Product checkout and the release");
  });

  it("refuses an argument past the release, such as a flag's value given after a space", () => {
    expect(refused(".", "v1.4.2", "--time-zone", "Europe/London")).toContain("--time-zone");
    expect(refused(".", "v1.4.2", "Europe/London")).toContain("Europe/London");
  });

  it("refuses a flag it doesn't know, naming it", () => {
    expect(refused(".", "v1.4.2", "--pause")).toContain("--pause");
  });

  it("refuses a value on a yes-or-no flag", () => {
    expect(refused(".", "v1.4.2", "--paused=yes")).toContain("--paused");
  });

  it("refuses an empty --account=", () => {
    expect(refused(".", "v1.4.2", "--account=")).toContain("--account=");
  });

  it("lists every flag in its usage line, and no other", () => {
    const flags = [
      // The bootstrap's own, which names the release, as a first argument does.
      "--release=",
      "--account=",
      "--time-zone=",
      "--no-time-zone",
      "--second-subscription",
      "--no-second-subscription",
      "--paused",
      "--no-paused",
      "--plan",
    ];

    expect(SETUP_USAGE.split("\n")).toHaveLength(1);
    expect([...SETUP_USAGE.matchAll(/--[a-z-]+=?/g)].map((match) => match[0]).sort()).toEqual([...flags].sort());
  });

  it("takes every flag its usage line lists, but the one the bootstrap takes itself", () => {
    const values: Record<string, string> = {
      "--account=": "my.1password.com",
      "--time-zone=": "Europe/London",
    };

    for (const [flag] of SETUP_USAGE.matchAll(/--[a-z-]+=?/g)) {
      // setup.sh turns --release= into the release it downloads, and never passes it on.
      if (flag === "--release=") continue;
      expect(parseSetupArgs([".", "v1.4.2", `${flag}${values[flag] ?? ""}`]).ok, flag).toBe(true);
    }
  });
});
