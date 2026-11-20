// The notes for the release that lets a Product repo opt in to Fable are
// drafted ahead, beside the others (#834). While they are a draft they must
// say what the code does: the names and the Kit's own words they give are the
// ones the code holds. Once the release ships they are a record, listed in
// RELEASED_NOTES, and keep the words of their day.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, RELEASED_NOTES } from "../__fixtures__/repoScan.ts";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { FABLE_FALLBACK_MODEL, fableCapMarker, UNTIMED_CAP_MS } from "../loop/fableCap.ts";
import { planFor } from "../loop/rules.ts";
import { refuseRoleModel } from "./config.ts";
import { kitJobSummary } from "./kitJob.ts";
import { RUN_RECORD_SCHEMA } from "./runRecord.ts";

const NOTES = "docs/release-notes/fable-opt-in.md";

const read = (path: string): Promise<string> => readFile(join(KIT, path), "utf8");

describe.skipIf(RELEASED_NOTES.has(NOTES))("The Fable opt-in's release notes, while drafted", () => {
  it("open with what they are the notes for, and the releasing guide lists them after the Evidence shots notes among the drafted notes", async () => {
    const notes = await read(NOTES);
    expect(notes.split("\n")[0]).toBe("# Release notes: Fable for a Product repo that opts in");
    expect(notes).toMatch(/^The notes for the minor release that lets a Product repo opt in to Fable .*\[#828\]\(https:\/\/github\.com\/jrey8343\/fabrik\/issues\/828\)/m);
    expect(notes).toContain("[ADR-0034](../adr/0034-a-product-repo-can-opt-in-to-fable-for-its-afk-roles-behind-the-overage-stop-and-the-fable-fallback.md)");
    expect(notes).toContain("Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.");
    const releasing = await read("docs/releasing.md");
    const drafted = releasing.split("\n").find((line) => line.includes("Notes drafted ahead of a release are in `docs/release-notes/`"));
    expect(drafted).toContain("[UI evidence from Evidence shots](release-notes/evidence-shots.md), the Fable opt-in minor's ([#828](https://github.com/jrey8343/fabrik/issues/828)) are [Fable for a Product repo that opts in](release-notes/fable-opt-in.md)");
  });

  it("say how to turn it on: usage credits off on every listed Subscription first, then allow_fable and a Fable model by its full id, the Pilot's bump first", async () => {
    const notes = await read(NOTES);
    const turnOn = section(notes, "To turn it on");
    expect(turnOn).toContain("usage credits off on every listed Subscription");
    expect(turnOn).toContain('"allow_fable": true');
    expect(turnOn).toContain("`claude-fable-5-2`");
    expect(turnOn).toContain("Pilot");
    expect(turnOn.indexOf("usage credits off")).toBeLessThan(turnOn.indexOf('"allow_fable": true'));
  });

  // The Spec leaves the Pilot as it is (#828's first user story), so the opt-in is the one step the Pilot doesn't take first.
  it("say that leaving the Pilot off Fable is an exception to the releasing guide's Pilot-first rule, and why", async () => {
    const turnOn = section(await read(NOTES), "To turn it on");
    expect(await read("docs/releasing.md")).toContain("to turn it on for the Pilot first");
    expect(turnOn).toContain("This is an exception to the releasing guide's rule to turn a release's opt-in on for the Pilot first");
    expect(turnOn).toContain("leave the Pilot as it is");
  });

  it("give the Kit's own words and figures for the opt-in, the fallback, the hidden line, the Run record and an unread store", async () => {
    const notes = await read(NOTES);
    const day = 24 * 60 * 60 * 1000;
    const optedIn = kitConfig({
      allowFable: true,
      roles: { ...kitConfig().roles, triage: { ...kitConfig().roles.triage, model: "claude-fable-5-2" } },
    });
    const plan = planFor({ kind: "label-added", issue: 7, label: "needs-triage" }, snapshotOf(anIssue({ number: 7, labels: ["needs-triage"] })), optedIn);
    const unread = kitJobSummary(plan, optedIn, [], { storeUnread: true })?.split("\n\n").at(-1)?.trim();

    expect(notes).toContain(`set \`allow_fable\` to \`true\` to opt in`);
    expect(refuseRoleModel("claude-fable-5-2", false)).toContain("set allow_fable to true to opt in");
    expect(notes).toContain(`"${refuseRoleModel("best", true)}"`);
    expect(refuseRoleModel("best", false)).toBe(refuseRoleModel("best", true));
    expect(notes).toContain(`on \`${FABLE_FALLBACK_MODEL}\` at the role's effort`);
    expect(notes).toContain(`\`${fableCapMarker({ subscription: "<Subscription>", until: "<reset>" })}\``);
    expect(notes).toContain(`for ${UNTIMED_CAP_MS / day} days`);
    expect(notes).toContain(`schema ${RUN_RECORD_SCHEMA}`);
    expect(notes).toContain(`"${unread}"`);
  });

  it("say how to revert: remove allow_fable and name non-Fable models", async () => {
    const notes = await read(NOTES);
    expect(section(notes, "To turn it off")).toContain("remove `allow_fable` and name non-Fable models");
  });
});

/** The notes' `## heading` section, to the next `## ` heading; empty when there is none. */
function section(notes: string, heading: string): string {
  const start = notes.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const end = notes.indexOf("\n## ", start + 1);
  return notes.slice(start, end === -1 ? undefined : end);
}
