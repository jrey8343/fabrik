import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_SECTIONS, auditContext } from "./audit.ts";
import type { AuditInputs } from "./inputs.ts";

const sha = (c: string) => c.repeat(40);

const inputs: AuditInputs = {
  audit: { number: 45, commit: sha("b") },
  window: { kind: "since-audit", audit: 40, commit: sha("a") },
  drift: [{ path: "src/booking/slots.ts", changes: 6 }],
  closedAudits: [
    {
      number: 40,
      title: "Audit: week of 2026-11-01",
      commit: sha("a"),
      closedAs: "not_planned",
      body: "## Split the slot rules out of booking",
      operatorComments: [{ url: "https://github.com/acme/shop/issues/40#issuecomment-1", createdAt: "2026-11-02T00:00:00Z", body: "Booking owns them on purpose." }],
    },
  ],
  filedCandidates: [{ number: 60, title: "Rename the invoice module", fromAudit: 38, body: "Rename it.\n\nFrom audit #38" }],
  pullRequests: [
    { number: 50, title: "Add slot rules", mergeCommit: sha("c"), headRefName: "fabrik/ticket-10", mergedAt: "2026-11-05T00:00:00Z", files: ["src/booking/slots.ts"] },
  ],
};

async function fileOf(value: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fabrik-audit-")), "audit.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

const json = (value: unknown) => ["```json", JSON.stringify(value, null, 2), "```"];

describe("An Auditor run's context", () => {
  it("names the pending Audit's number and marked commit under its heading, sets out each other input in its own section, and gives back the window its result records", async () => {
    const { window, parts } = await auditContext(await fileOf(inputs));

    expect(window).toEqual({ kind: "since-audit", audit: 40, commit: sha("a") });
    expect(parts).toEqual([
      // Still under the pending Audit's heading, after its issue.
      `This is Audit #45. Its marked commit, which you're checked out at, is \`${sha("b")}\`.`,
      `## ${AUDIT_SECTIONS.window}`,
      ...json(inputs.window),
      `## ${AUDIT_SECTIONS.drift}`,
      ...json(inputs.drift),
      `## ${AUDIT_SECTIONS.pullRequests}`,
      ...json(inputs.pullRequests),
      `## ${AUDIT_SECTIONS.closedAudits}`,
      ...json(inputs.closedAudits),
      `## ${AUDIT_SECTIONS.filedCandidates}`,
      ...json(inputs.filedCandidates),
    ]);
  });

  it.each([
    ["no pending Audit", { ...inputs, audit: undefined }],
    ["a pending Audit with no marked commit", { ...inputs, audit: { number: 45 } }],
    ["no window", { ...inputs, window: undefined }],
    ["a window of neither kind", { ...inputs, window: { kind: "since-forever" } }],
    ["a list left out", { ...inputs, pullRequests: undefined }],
  ])("refuses an inputs file with %s, so the run fails rather than audits blind", async (_, broken) => {
    await expect(auditContext(await fileOf(broken))).rejects.toThrow(/audit\.json/);
  });
});
