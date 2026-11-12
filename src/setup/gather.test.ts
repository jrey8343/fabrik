// What setup reads of a repo's Deployments, with the Operator's own gh, to
// offer production's environment and address: each environment's name, and
// the address on its newest successful Deployment where GitHub has one.
import { describe, expect, it } from "vitest";
import { type Answer, fakeCommands } from "../__fixtures__/setupCommands.ts";
import { gatherDeployments } from "./gather.ts";

const REPO = { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: false };
const page = (n: number) => `gh api repos/acme/clinic/deployments?per_page=100&page=${n}`;
const LIST = page(1);
const statuses = (id: number) => `gh api repos/acme/clinic/deployments/${id}/statuses?per_page=100`;

const json = (value: unknown): Answer => ({ stdout: JSON.stringify(value) });
const deployment = (id: number, environment: string, createdAt: string) => ({ id, environment, created_at: createdAt });
const status = (state: string, url = "") => ({ state, environment_url: url });

async function read(script: Record<string, Answer>) {
  const commands = fakeCommands(script);
  return { seen: await gatherDeployments(commands.run, "/clinic", REPO), calls: commands.calls.map((call) => call.line) };
}

describe("Reading a repo's Deployments for production's question", () => {
  it("gives each environment, newest first, with the address on its newest successful Deployment", async () => {
    const { seen } = await read({
      [LIST]: json([
        deployment(3, "preview", "2026-11-10T09:00:00Z"),
        deployment(2, "production", "2026-11-09T09:00:00Z"),
        deployment(1, "production", "2026-11-08T09:00:00Z"),
      ]),
      [statuses(3)]: json([status("success", "https://pr-4.clinic.example.dev")]),
      // The newest failed; the one before succeeded, and GitHub turned that success inactive when a later one came.
      [statuses(2)]: json([status("failure"), status("in_progress")]),
      [statuses(1)]: json([status("inactive", "https://clinic.example.com"), status("success", "https://clinic.example.com")]),
    });

    expect(seen).toEqual({
      read: true,
      environments: [
        { name: "preview", url: "https://pr-4.clinic.example.dev" },
        { name: "production", url: "https://clinic.example.com" },
      ],
    });
  });

  it("gives no address for an environment none of whose Deployments succeeded with one", async () => {
    const { seen } = await read({
      [LIST]: json([deployment(2, "staging", "2026-11-09T09:00:00Z"), deployment(1, "production", "2026-11-08T09:00:00Z")]),
      [statuses(2)]: json([status("success")]),
      [statuses(1)]: json([status("in_progress", "https://clinic.example.com")]),
    });

    expect(seen).toEqual({ read: true, environments: [{ name: "staging", url: null }, { name: "production", url: null }] });
  });

  it("takes an address GitHub holds that isn't http or https as none", async () => {
    const { seen } = await read({
      [LIST]: json([deployment(1, "production", "2026-11-08T09:00:00Z")]),
      [statuses(1)]: json([status("success", "ftp://clinic.example.com")]),
    });

    expect(seen).toEqual({ read: true, environments: [{ name: "production", url: null }] });
  });

  it("gives no environments for a repo that reports no Deployments", async () => {
    expect((await read({ [LIST]: json([]) })).seen).toEqual({ read: true, environments: [] });
  });

  it("lists an environment none of whose Deployments is among the newest hundred", async () => {
    const previews = Array.from({ length: 100 }, (_, i) => deployment(200 - i, "preview", `2026-11-10T09:${String(i % 60).padStart(2, "0")}:00Z`));
    const script: Record<string, Answer> = {
      [page(1)]: json(previews),
      [page(2)]: json([deployment(1, "production", "2026-10-01T09:00:00Z")]),
      [statuses(1)]: json([status("success", "https://clinic.example.com")]),
    };
    for (const { id } of previews) script[statuses(id)] = json([status("success", "https://pr.clinic.example.dev")]);

    const { seen } = await read(script);

    expect(seen).toEqual({
      read: true,
      environments: [
        { name: "preview", url: "https://pr.clinic.example.dev" },
        { name: "production", url: "https://clinic.example.com" },
      ],
    });
  });

  it("reads further back than a run of failed Deployments for the newest that succeeded, and no further", async () => {
    const many = Array.from({ length: 9 }, (_, i) => deployment(9 - i, "production", `2026-11-0${9 - i}T09:00:00Z`));
    const script: Record<string, Answer> = { [LIST]: json(many) };
    for (const { id } of many) script[statuses(id)] = json([status("failure")]);
    script[statuses(2)] = json([status("inactive", "https://clinic.example.com"), status("success", "https://clinic.example.com")]);

    const { seen, calls } = await read(script);

    expect(seen).toEqual({ read: true, environments: [{ name: "production", url: "https://clinic.example.com" }] });
    expect(calls.filter((line) => line.includes("/statuses"))).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map(statuses));
  });

  it("says why when the read is refused, and fails nothing", async () => {
    const { seen } = await read({ [LIST]: { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)\n" } });

    expect(seen).toEqual({ read: false, why: "gh: Resource not accessible by integration (HTTP 403)" });
  });

  it("says why when GitHub's answer can't be read, and fails nothing", async () => {
    const { seen } = await read({ [LIST]: { stdout: "<html>" } });

    expect(seen.read).toBe(false);
  });

  it("takes a refused read of one Deployment's statuses as no address there", async () => {
    const { seen } = await read({
      [LIST]: json([deployment(1, "production", "2026-11-08T09:00:00Z")]),
      [statuses(1)]: { code: 1, stderr: "gh: Not Found (HTTP 404)" },
    });

    expect(seen).toEqual({ read: true, environments: [{ name: "production", url: null }] });
  });
});
