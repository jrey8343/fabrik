// What one setup run says at its end: the setup PR's body, and the closing
// lines in the Operator's terminal, with the merge asked for only when nothing
// holds it back.
import { describe, expect, it } from "vitest";
import { closingLines, prBody, setupCommand, withEarlierDone } from "./finish.ts";
import { type BranchProtection, UNPROTECTED } from "./plan.ts";
import { type RunSummary, stepsDone } from "./oneRun.ts";

const SUMMARY: RunSummary = {
  done: ["write .github/workflows/fabrik.yml (the caller workflow)", "create the label needs-triage"],
  notes: ["main has no Required checks yet: list the CI checks that must pass in sandbox.checks in .fabrik/config.json, then run setup again."],
  blockers: [],
};
const BLOCKED: RunSummary = { ...SUMMARY, blockers: ['the Claude token, in the "Fabrik" vault'] };
const PAUSED: RunSummary = { ...SUMMARY, pausesDispatch: true };
const BY_HAND = 'the "Claude backup" Subscription\'s token, in the "Fabrik" vault';
const COMMAND = "curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- v1.4.2";

describe("The setup PR's body", () => {
  it("lists what setup did and every note, and says the Operator merges it", () => {
    const body = prBody({ release: "v1.4.2", defaultBranch: "main", summary: SUMMARY });

    expect(body).toContain("- write .github/workflows/fabrik.yml (the caller workflow)\n- create the label needs-triage");
    expect(body).toContain(`- ${SUMMARY.notes[0]}`);
    expect(body).toContain("Merge this PR yourself once its Required checks pass.");
  });

  it("with the Claude token skipped, says not to merge yet, why, and how to finish", () => {
    const body = prBody({ release: "v1.4.2", defaultBranch: "main", summary: BLOCKED });

    expect(body).toContain("Don't merge this yet. The Kit's first runs need these, which setup's wizard didn't finish:");
    expect(body).toContain('- the Claude token, in the "Fabrik" vault');
    expect(body).toContain(COMMAND);
    expect(body).not.toContain("Merge this PR yourself");
  });

  it("with a listed Subscription's token no wizard stage stores, says to store it by hand, after what the wizard didn't finish", () => {
    const body = prBody({ release: "v1.4.2", defaultBranch: "main", summary: { ...BLOCKED, storeByHand: [BY_HAND] } });

    expect(body).toContain(
      `\`\`\`\n\nThe Kit's first runs also need these, which no wizard stage stores, so you store them yourself, as For the Operator says:\n\n- ${BY_HAND}\n`,
    );
    expect(body).not.toMatch(/merge this PR yourself/i);
  });

  it("says Dispatch is paused only when the Kit config it merges pauses it", () => {
    const paused = "Dispatch is paused, so no Implementer starts until you set max_in_flight in .fabrik/config.json above 0.";

    expect(prBody({ release: "v1.4.2", defaultBranch: "main", summary: PAUSED })).toContain(`\n\n${paused}\n`);
    expect(prBody({ release: "v1.4.2", defaultBranch: "main", summary: SUMMARY })).not.toContain(paused);
  });

  it("keeps what an earlier run did, so a run that picks up the same PR adds to its list", () => {
    const earlier = prBody({ release: "v1.4.2", defaultBranch: "main", summary: BLOCKED });

    expect(withEarlierDone(earlier, ["create the label needs-info"])).toEqual([
      "write .github/workflows/fabrik.yml (the caller workflow)",
      "create the label needs-triage",
      "create the label needs-info",
    ]);
    expect(withEarlierDone(null, ["create the label needs-info"])).toEqual(["create the label needs-info"]);
  });

  it("lists each step once, where it was last done, so the list ends on what the setup branch holds", () => {
    const paused = "write .fabrik/config.json (the starter Kit config, with Dispatch paused now (max_in_flight 0))";
    const unpaused = "write .fabrik/config.json (the starter Kit config, with Dispatch not paused now (max_in_flight 2))";
    const earlier = prBody({ release: "v1.4.2", defaultBranch: "main", summary: { ...SUMMARY, done: [...SUMMARY.done, paused, unpaused] } });

    expect(withEarlierDone(earlier, [paused, "create the label needs-info"])).toEqual([
      "write .github/workflows/fabrik.yml (the caller workflow)",
      "create the label needs-triage",
      unpaused,
      paused,
      "create the label needs-info",
    ]);
  });

  it("drops control characters from what the earlier PR's body says, since the closing lines print it to the terminal", () => {
    const earlier = "## What setup did\n\n- create the label needs-triage\u001b]52;c;ZXZpbA==\u0007\u009b2J\n";

    expect(withEarlierDone(earlier, [])).toEqual(["create the label needs-triage]52;c;ZXZpbA==2J"]);
  });
});

describe("The closing lines", () => {
  it("give the PR, what setup did and its notes again, since the wizard clears the screen", () => {
    const lines = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: SUMMARY });

    expect(lines).toContain("The setup PR: https://github.com/acme/clinic/pull/7");
    expect(lines).toContain("- create the label needs-triage");
    expect(lines).toContain(`- ${SUMMARY.notes[0]}`);
  });

  it("ask for the merge once nothing holds it back", () => {
    const lines = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: SUMMARY });

    expect(lines.join("\n")).toMatch(/^Merge it yourself once its Required checks pass\./m);
  });

  it("with the Claude token skipped, don't ask for the merge, and say which and that the Kit's first runs need it", () => {
    const text = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: BLOCKED }).join("\n");

    expect(text).not.toMatch(/Merge it yourself/);
    expect(text).toContain("Don't merge it yet. The Kit's first runs need these, which the wizard didn't finish:\n- the Claude token, in the \"Fabrik\" vault");
    expect(text).toContain(`Run setup again to walk the wizard for them: ${COMMAND}`);
  });

  it("with a listed Subscription's token no wizard stage stores, say to store it by hand, after what the wizard didn't finish", () => {
    const summary = { ...BLOCKED, storeByHand: [BY_HAND] };
    const text = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary }).join("\n");

    expect(text).toContain(
      `Run setup again to walk the wizard for them: ${COMMAND}\nThe Kit's first runs also need these, which no wizard stage stores, so you store them yourself, as For the Operator says:\n- ${BY_HAND}\n\nThen:`,
    );
    expect(text).not.toMatch(/merge it yourself/i);
  });

  it("give the finishing guidance, naming the setup command wherever it says to run setup again", () => {
    const text = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: SUMMARY }).join("\n");

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

  it("say how to resume Dispatch when the Kit config the setup PR merges pauses it", () => {
    const text = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary: PAUSED }).join("\n");

    expect(text).toContain("- Dispatch is paused, so no Implementer starts until you set max_in_flight in .fabrik/config.json above 0.");
  });
});

describe("The closing lines' Then list, leaving out each step the Kit config and repo show done", () => {
  const then = (summary: RunSummary) => {
    const lines = closingLines({ release: "v1.4.2", defaultBranch: "main", url: "https://github.com/acme/clinic/pull/7", summary });
    return lines.slice(lines.indexOf("Then:") + 1);
  };
  const has = (summary: RunSummary, start: string) => then(summary).some((line) => line.startsWith(`- ${start}`));
  const NOTES = {
    checks: "List the CI checks",
    extraSkills: "To give roles Extra skills",
    monitor: "The Monitor files an issue",
    visualEvidence: "With Visual evidence on",
  } as const;

  it.each(Object.entries(NOTES))("leaves out the %s note when that step is done, and gives it when it isn't", (step, start) => {
    expect(has({ ...SUMMARY, alreadyDone: { [step]: true } }, start)).toBe(false);
    expect(has({ ...SUMMARY, alreadyDone: { [step]: false } }, start)).toBe(true);
    expect(has(SUMMARY, start)).toBe(true);
  });

  it("with an invalid Kit config, gives every note as before", () => {
    const alreadyDone = stepsDone({ kitConfig: '{ "sandbox": { "checks": ["gate"] }, "ui": false }', skillsLock: null, protection: null, appItems: [] });

    expect(then({ ...SUMMARY, alreadyDone })).toEqual(then(SUMMARY));
  });

  it("always gives the Weekly summary and repair notes, and the paused-Dispatch note as before", () => {
    const allDone = { checks: true, extraSkills: true, monitor: true, visualEvidence: true };
    const lines = then({ ...PAUSED, alreadyDone: allDone });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- Once the Fabrik App is on fabrik-runs/);
    expect(lines[1]).toMatch(/^- Dispatch is paused/);
    expect(lines[2]).toMatch(/^- Running setup again repairs the install/);
    expect(then({ ...SUMMARY, alreadyDone: allDone })).toHaveLength(2);
  });
});

describe("The steps the setup branch's Kit config and the repo show done", () => {
  const SHA = "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d";
  const LOCK = JSON.stringify([{ repository: "acme/skills", sha: SHA }]);
  const requiring = (...contexts: string[]): BranchProtection => ({
    ...UNPROTECTED,
    required_status_checks: { strict: true, checks: contexts.map((context) => ({ context })) },
  });
  const facts = (config: object | string | null, { skillsLock = null as string | null, protection = null as BranchProtection | null, appItems = [] as string[] } = {}) =>
    stepsDone({ kitConfig: typeof config === "object" && config !== null ? JSON.stringify(config) : config, skillsLock, protection, appItems });

  it("has the checks done once sandbox.checks lists checks the default branch requires, every one", () => {
    const config = { sandbox: { checks: ["gate"] } };
    expect(facts(config, { protection: requiring("gate", "lint") }).checks).toBe(true);
    expect(facts(config, { protection: requiring("lint") }).checks).toBe(false);
    expect(facts(config, { protection: null }).checks).toBe(false);
    expect(facts({ sandbox: { checks: [] } }, { protection: requiring("gate") }).checks).toBe(false);
  });

  it("has the Extra skills done once the lockfile pins a source and some role picks skills", () => {
    const picks = { roles: { design: { skills: ["acme/skills/event-storming"] } } };
    expect(facts(picks, { skillsLock: LOCK }).extraSkills).toBe(true);
    expect(facts({}, { skillsLock: LOCK }).extraSkills).toBe(false);
    expect(facts({}, { skillsLock: "[]" }).extraSkills).toBe(false);
    expect(facts({}).extraSkills).toBe(false);
  });

  it("has the Monitor done once monitor.errors names a provider and the Fabrik App vault holds the Sentry token", () => {
    const sentry = { monitor: { errors: { provider: "sentry", org: "acme", project: "clinic" } } };
    expect(facts(sentry, { appItems: ["Fabrik App", "Sentry token"] }).monitor).toBe(true);
    expect(facts(sentry, { appItems: ["Fabrik App"] }).monitor).toBe(false);
    expect(facts({ monitor: { errors: null } }, { appItems: ["Sentry token"] }).monitor).toBe(false);
  });

  it("has Visual evidence done once ui is set", () => {
    expect(facts({ ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321" } }).visualEvidence).toBe(true);
    expect(facts({ ui: null }).visualEvidence).toBe(false);
  });

  it.each([
    ["invalid", '{ "sandbox": { "checks": ["gate"] }, "ui": false }'],
    ["unreadable", "{ not json"],
    ["missing", null],
  ])("with a Kit config that's %s, has nothing done", (_, config) => {
    expect(facts(config, { skillsLock: LOCK, protection: requiring("gate"), appItems: ["Sentry token"] })).toEqual({
      checks: false,
      extraSkills: false,
      monitor: false,
      visualEvidence: false,
    });
  });
});

describe("The setup command", () => {
  it("is the bootstrap command, naming the release", () => {
    expect(setupCommand("v1.4.2")).toBe(COMMAND);
  });
});
