// The Operator session in the docs (Spec #918): the glossary's five entries under
// "The loop" that say a Pairing session may run as an Operator session, with the
// Session environment straight after the Operator session, and ADR-0005's and
// ADR-0009's consequences on a Pairing session, which no longer say it runs
// beside the Operator or locally.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const glossary = read("GLOSSARY.md");
/** The glossary's "The loop" section, from its heading to the next `##` heading. */
const theLoop = glossary.split("\n## The loop\n")[1]?.split("\n## ")[0] ?? "";

/** A glossary entry as the file writes it: its term, its definition and its _Avoid_ line. */
const entry = (term: string, definition: string, avoid: string) => `\n**${term}**:\n${definition}\n_Avoid_: ${avoid}\n`;

const spec = entry(
  "Spec",
  "A design written up in a Design session, or from a Map's Decisions by the Map's own last tasks, the parent of the Tickets that build it. The Kit recognises a Spec by its `ready-for-agent` or `ready-for-human` state label; any other parent (a Map, or an issue a Product repo keeps open to track its work) is not one, and Spec closing leaves it open.",
  "PRD, plan",
);
const pairingSession = entry(
  "Pairing session",
  "The Operator and an agent that counts as the Operator working through an issue that waits on the Operator, step by step, with what was done recorded on the issue as it happens. An issue may take several.",
  "walkthrough, hand-off",
);
const operatorSession = entry(
  "Operator session",
  "A live session between the Operator and an agent that acts as the Operator, on an issue that waits on them, with no machine of the Operator's running. The Console starts one from the issue's row. A Pairing session run this way is one, and so is the working of a Map's HITL Decision.",
  "remote session, cloud session (where one may run, not what it is), chat",
);
const sessionEnvironment = entry(
  "Session environment",
  "Where an Operator session is opened, kept on a Subscription for Operator sessions alone: the bare one, which holds no credential and serves every repo that attaches none, or a repo's own, which holds what that repo attaches.",
  "cloud environment (what one is made as, not what it is for)",
);
const trustRootFile = entry(
  "Trust-root file",
  "A file in a Product repo that steers how agents behave or how their work is judged, so agents may never change it. An agent in a Pairing session or an Operator session counts as the Operator, so it may.",
  "config file, protected file",
);

describe("the glossary's entries on the Operator session", () => {
  it.each([
    ["Spec", spec],
    ["Pairing session", pairingSession],
    ["Operator session", operatorSession],
    ["Session environment", sessionEnvironment],
    ["Trust-root file", trustRootFile],
  ])("has %s, as written, under The loop", (_term, text) => {
    expect(theLoop).toContain(text);
  });

  it("has the Session environment straight after the Operator session", () => {
    expect(theLoop).toContain(`${operatorSession}${sessionEnvironment}`);
  });

  it("has each of the five terms once", () => {
    for (const term of ["Spec", "Pairing session", "Operator session", "Session environment", "Trust-root file"]) {
      expect(glossary.split(`\n**${term}**:\n`)).toHaveLength(2);
    }
  });
});

describe("ADR-0005 on a Pairing session", () => {
  const adr = read("docs/adr/0005-push-job-refuses-trust-root-changes.md");

  it("has its first consequence say a Pairing session counts as the Operator in the terminal and as an Operator session alike", () => {
    const consequences = adr.split("\n## Consequences\n")[1] ?? "";

    expect(consequences.split("\n").find((line) => line.startsWith("- "))).toBe(
      "- A Pairing session counts as the Operator, not as an agent, in the Operator's terminal and as an Operator session alike: it acts on the Operator's own credentials, and its file changes go out in a pull request that only the Operator merges. So it may change trust-root files. The push job never sees its branch.",
    );
  });

  it("no longer says the Operator is beside it at every step", () => {
    expect(adr).not.toContain("the Operator is beside it at every step");
  });
});

describe("ADR-0009 on a Pairing session", () => {
  const adr = read("docs/adr/0009-run-records-live-in-a-central-private-repo.md");
  const consequence = adr.split("\n").find((line) => line.startsWith("- A Pairing session")) ?? "";

  it("has its consequence say a Pairing session writes no record in the terminal or as an Operator session", () => {
    expect(consequence).toBe(
      "- A Pairing session writes no record, in the Operator's terminal or as an Operator session. It has no push job, nothing outside it can read what it cost, and it counts as a Human touch instead.",
    );
    expect(adr.split("\n").filter((line) => line.startsWith("- A Pairing session"))).toHaveLength(1);
  });

  it("no longer says it runs locally", () => {
    expect(consequence).not.toContain("It runs locally");
  });
});
