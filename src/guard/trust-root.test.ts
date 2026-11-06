import { describe, expect, it } from "vitest";
import { checkTrustRoot } from "./trust-root.ts";

describe("Trust-root guard", () => {
  it("allows an ordinary source change", () => {
    expect(checkTrustRoot([{ path: "src/booking/waitlist.ts" }])).toEqual({ kind: "allow" });
  });

  it("returns empty diff, not allow, when the branch changes nothing", () => {
    expect(checkTrustRoot([])).toEqual({ kind: "empty-diff" });
  });

  it("refuses a change to AGENTS.md, naming the path", () => {
    expect(checkTrustRoot([{ path: "AGENTS.md" }])).toEqual({ kind: "refuse", paths: ["AGENTS.md"] });
  });

  it.each([
    ["AGENTS.md", "AGENTS.md"],
    ["CLAUDE.md", "CLAUDE.md"],
    ["Claude settings", ".claude/settings.json"],
    ["local Claude settings", ".claude/settings.local.json"],
    ["a skill", ".claude/skills/tdd/SKILL.md"],
    ["the Kit's Review prompt", "prompts/review.md"],
    ["the Kit's Implement prompt", "prompts/implement.md"],
    ["the Kit's Triage prompt", "prompts/triage.md"],
    ["the Kit's Design prompt", "prompts/design.md"],
    ["the Kit's Audit prompt", "prompts/audit.md"],
    ["the Kit's Retro prompt", "prompts/retro.md"],
    ["the Kit's Efficiency rubric", "prompts/scorers/efficiency.md"],
    ["a new rubric beside the Kit's", "prompts/scorers/verbosity.md"],
    ["the Kit config", ".fabrik/config.yml"],
    ["a phase file", ".fabrik/implement.md"],
    ["a workflow", ".github/workflows/fabrik.yml"],
    ["the Coding standards", "CODING_STANDARDS.md"],
    ["the Vision", "docs/product/vision.md"],
    ["the Roadmap", "docs/product/roadmap.md"],
    ["another file beside the Vision", "docs/product/end-users/clinic-owners.md"],
  ])("refuses a change to %s", (_class, path) => {
    expect(checkTrustRoot([{ path }])).toEqual({ kind: "refuse", paths: [path] });
  });

  it.each([
    "apps/web/.claude/settings.local.json",
    "apps/web/.claude/settings.json",
    "packages/api/AGENTS.md",
    "packages/api/CLAUDE.md",
    "apps/web/.claude/skills/deploy/SKILL.md",
  ])("refuses the nested trust-root file %s", (path) => {
    expect(checkTrustRoot([{ path }])).toEqual({ kind: "refuse", paths: [path] });
  });

  it.each([
    "docs/AGENTS.md.bak",
    "src/settings.json",
    "src/.claude-ish/settings.json",
    "src/prompts/welcome.ts",
    "src/prompts/scorers/efficiency.md",
    "src/.fabrik/notes.md",
    "docs/github/workflows/how-we-deploy.md",
    "MYAGENTS.md",
    // A Product's own prompts folder: only the Kit's role prompts are trust roots.
    "prompts/onboarding.md",
    "prompts/chatbot/system.txt",
    // Coding standards are a Trust root only at the repo root.
    "docs/CODING_STANDARDS.md",
    "packages/api/CODING_STANDARDS.md",
    // Only the docs/product/ folder at the repo root holds the Vision and Roadmap.
    "packages/web/docs/product/vision.md",
    "docs/products/vision.md",
    "docs/product.md",
    "src/product/vision.ts",
  ])("allows %s, which only looks like a trust-root path", (path) => {
    expect(checkTrustRoot([{ path }])).toEqual({ kind: "allow" });
  });

  it.each([
    ["out of a trust-root path, naming where it came from", "CLAUDE.md", "docs/old-claude.md", "CLAUDE.md"],
    ["into a trust-root path, naming where it went", "docs/draft-review.md", "prompts/review.md", "prompts/review.md"],
    ["out of docs/product/, naming where it came from", "docs/product/vision.md", "docs/vision-draft.md", "docs/product/vision.md"],
    ["into docs/product/, naming where it went", "docs/roadmap-draft.md", "docs/product/roadmap.md", "docs/product/roadmap.md"],
  ])("refuses a rename %s", (_rename, from, path, refused) => {
    expect(checkTrustRoot([{ from, path }])).toEqual({ kind: "refuse", paths: [refused] });
  });

  it("allows a rename between two ordinary paths", () => {
    expect(checkTrustRoot([{ from: "src/old.ts", path: "src/new.ts" }])).toEqual({ kind: "allow" });
  });

  it("lists every offending path in a mix of allowed and refused changes, not just the first", () => {
    const plan = checkTrustRoot([
      { path: "src/booking/waitlist.ts" },
      { path: "AGENTS.md" },
      { path: "src/booking/waitlist.test.ts" },
      { path: "apps/web/.claude/settings.local.json" },
      { path: ".github/workflows/ci.yml" },
      { from: ".fabrik/review.md", path: "docs/review.md" },
    ]);

    expect(plan).toEqual({
      kind: "refuse",
      paths: ["AGENTS.md", "apps/web/.claude/settings.local.json", ".github/workflows/ci.yml", ".fabrik/review.md"],
    });
  });

  it("allows a change set made only of ordinary paths", () => {
    const plan = checkTrustRoot([
      { path: "README.md" },
      { path: "src/booking/waitlist.ts" },
      { path: "docs/adr/0007-waitlist.md" },
    ]);

    expect(plan).toEqual({ kind: "allow" });
  });
});
