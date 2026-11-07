// What one setup run says at its end: the setup PR's body, and the closing
// lines in the Operator's terminal, with the merge asked for only when nothing
// holds it back.
import { describe, expect, it } from "vitest";
import { closingLines, prBody, setupCommand, withEarlierDone } from "./finish.ts";
import type { RunSummary } from "./oneRun.ts";

const SUMMARY: RunSummary = {
  done: ["write .github/workflows/fabrik.yml (the caller workflow)", "create the label needs-triage"],
  notes: ["main requires no gating checks yet: list the CI checks that must pass in sandbox.checks in .fabrik/config.json, then run setup again."],
  blockers: [],
};
const BLOCKED: RunSummary = { ...SUMMARY, blockers: ['the Claude token, in the "Fabrik" vault'] };
const COMMAND = "curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v1.4.2";

describe("The setup PR's body", () => {
  it("lists what setup did and every note, and says the Operator merges it", () => {
    const body = prBody({ release: "v1.4.2", defaultBranch: "main", summary: SUMMARY });

    expect(body).toContain("- write .github/workflows/fabrik.yml (the caller workflow)\n- create the label needs-triage");
    expect(body).toContain(`- ${SUMMARY.notes[0]}`);
    expect(body).toContain("Merge this PR yourself once its gating checks pass.");
  });

  it("with the Claude token skipped, says not to merge yet, why, and how to finish", () => {
    const body = prBody({ release: "v1.4.2", defaultBranch: "main", summary: BLOCKED });

    expect(body).toContain("Don't merge this yet. The Kit's first runs need these, which setup's wizard didn't finish:");
    expect(body).toContain('- the Claude token, in the "Fabrik" vault');
    expect(body).toContain(COMMAND);
    expect(body).not.toContain("Merge this PR yourself");
  });

  it("keeps what an earlier run did, so a run that picks up the same PR adds to its list", () => {
    const earlier = prBody({ release: "v1.4.2", defaultBranch: "main", summary: BLOCKED });

    expect(withEarlierDone(earlier, ["create the label needs-info", "create the label needs-triage"])).toEqual([
      "write .github/workflows/fabrik.yml (the caller workflow)",
      "create the label needs-triage",
      "create the label needs-info",
    ]);
    expect(withEarlierDone(null, ["create the label needs-info"])).toEqual(["create the label needs-info"]);
  });

  it("drops control characters from what the earlier PR's body says, since the closing lines print it to the terminal", () => {
    const earlier = "## What setup did\n\n- create the label needs-triage\u001b]52;c;ZXZpbA==\u0007\u009b2J\n";

    expect(withEarlierDone(earlier, [])).toEqual(["create the label needs-triage]52;c;ZXZpbA==2J"]);
  });
});

describe("The closing lines", () => {
  it("give the PR, what setup did and its notes again, since the wizard clears the screen", () => {
    const lines = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: SUMMARY, paused: false });

    expect(lines).toContain("The setup PR: https://github.com/acme/clinic/pull/7");
    expect(lines).toContain("- create the label needs-triage");
    expect(lines).toContain(`- ${SUMMARY.notes[0]}`);
  });

  it("ask for the merge once nothing holds it back", () => {
    const lines = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: SUMMARY, paused: false });

    expect(lines.join("\n")).toMatch(/^Merge it yourself once its gating checks pass\./m);
  });

  it("with the Claude token skipped, don't ask for the merge, and say which and that the Kit's first runs need it", () => {
    const text = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: BLOCKED, paused: false }).join("\n");

    expect(text).not.toMatch(/Merge it yourself/);
    expect(text).toContain("Don't merge it yet. The Kit's first runs need these, which the wizard didn't finish:\n- the Claude token, in the \"Fabrik\" vault");
    expect(text).toContain(`Run setup again to walk the wizard for them: ${COMMAND}`);
  });

  it("give the finishing guidance, naming the setup command wherever it says to run setup again", () => {
    const text = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: SUMMARY, paused: false }).join("\n");

    expect(text).toContain("sandbox.checks");
    expect(text).toContain("Fabrik weekly summary");
    expect(text).toContain(".fabrik/skills.lock.json");
    expect(text).toContain("monitor.errors");
    expect(text).toContain("/fabrik-visual-evidence");
    expect(text).toContain(`Running setup again repairs the install`);
    expect(text).toContain(COMMAND);
    expect(text).not.toContain("/fabrik-setup");
    expect(text).not.toContain("max_in_flight");
  });

  it("say how to resume Dispatch when setup installed it paused", () => {
    const text = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: SUMMARY, paused: true }).join("\n");

    expect(text).toContain("max_in_flight");
  });
});

describe("The setup command", () => {
  it("is the bootstrap command, naming the release", () => {
    expect(setupCommand("v1.4.2")).toBe(COMMAND);
  });
});
