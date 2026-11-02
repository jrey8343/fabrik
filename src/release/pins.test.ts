import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkUpstreamPins } from "./pins.ts";

const pinned = {
  dependencies: { "@ai-hero/sandcastle": "0.12.0", "@anthropic-ai/claude-code": "2.1.316" },
  allowScripts: { "@anthropic-ai/claude-code": true },
};

const STALE_APPROVAL =
  "allowScripts must name @anthropic-ai/claude-code without a version, so its install script still runs after a Dependabot bump";

describe("a release's upstream pins", () => {
  it("accepts Sandcastle and the Claude Code CLI at exact versions", () => {
    expect(checkUpstreamPins(JSON.stringify(pinned))).toEqual([]);
  });

  it.each(["^0.12.0", "~0.12.0", "0.12", "latest", ">=0.12.0", "0.12.x"])(
    "refuses Sandcastle at %s, which is not one exact version",
    (version) => {
      const packageJson = { ...pinned, dependencies: { ...pinned.dependencies, "@ai-hero/sandcastle": version } };

      expect(checkUpstreamPins(JSON.stringify(packageJson))).toEqual([
        `@ai-hero/sandcastle must be pinned at an exact version, not ${JSON.stringify(version)}`,
      ]);
    },
  );

  it("refuses a release that doesn't depend on the Claude Code CLI at all", () => {
    const packageJson = { ...pinned, dependencies: { "@ai-hero/sandcastle": "0.12.0" } };

    expect(checkUpstreamPins(JSON.stringify(packageJson))).toEqual([
      "@anthropic-ai/claude-code must be a runtime dependency pinned at an exact version",
    ]);
  });

  it("refuses an install-script approval tied to one version, which a Dependabot bump would leave behind", () => {
    const packageJson = { ...pinned, allowScripts: { "@anthropic-ai/claude-code@2.1.316": true } };

    expect(checkUpstreamPins(JSON.stringify(packageJson))).toEqual([STALE_APPROVAL]);
  });

  it("refuses a release where the Claude Code CLI's install script is not approved", () => {
    const packageJson = { dependencies: pinned.dependencies };

    expect(checkUpstreamPins(JSON.stringify(packageJson))).toEqual([STALE_APPROVAL]);
  });

  it("holds for Fabrik's own package.json", () => {
    const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");

    expect(checkUpstreamPins(text)).toEqual([]);
  });
});
