// Finding a head's Evidence shots (#820): the newest attempt of the check
// Kit config's ui.shots names at a pull request's head, and the artifact it
// uploaded, read with the review job's own token, which holds `actions: read`.
import { describe, expect, it } from "vitest";
import type { ReadClient } from "../github/client.ts";
import { findShotsArtifact } from "./shotsRun.ts";

const HEAD = "a".repeat(40);
const REPO = { owner: "acme", name: "shop" };

interface Job {
  readonly name: string;
  readonly startedAt: string;
  readonly attempt?: number;
}
interface Artifact {
  readonly id: number;
  readonly createdAt: string;
  readonly expired?: boolean;
}
interface Run {
  readonly id: number;
  readonly jobs: readonly Job[];
  readonly artifacts?: readonly Artifact[];
}

/** A client that answers the Actions reads a head's runs, their jobs and their artifacts take, and logs each call. */
function actions(runs: readonly Run[]): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rest(_method, path) {
      calls.push(path);
      if (path === `/repos/acme/shop/actions/runs?head_sha=${HEAD}&per_page=100&page=1`) {
        return { total_count: runs.length, workflow_runs: runs.map(({ id }) => ({ id, head_sha: HEAD })) };
      }
      const jobs = /^\/repos\/acme\/shop\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100&page=1$/.exec(path);
      if (jobs !== null) {
        const run = runs.find(({ id }) => id === Number(jobs[1]));
        return { jobs: (run?.jobs ?? []).map((job, at) => ({ id: at + 1, name: job.name, started_at: job.startedAt, run_attempt: job.attempt ?? 1 })) };
      }
      const artifacts = /^\/repos\/acme\/shop\/actions\/runs\/(\d+)\/artifacts\?name=fabrik-evidence-shots&per_page=100&page=1$/.exec(path);
      if (artifacts !== null) {
        const run = runs.find(({ id }) => id === Number(artifacts[1]));
        return {
          artifacts: (run?.artifacts ?? []).map(({ id, createdAt, expired = false }) => ({ id, name: "fabrik-evidence-shots", created_at: createdAt, expired })),
        };
      }
      throw new Error(`Unexpected call: ${path}`);
    },
  };
}

const find = (client: Pick<ReadClient, "rest">) => findShotsArtifact(client, REPO, { headSha: HEAD, check: "e2e", artifact: "fabrik-evidence-shots" });

describe("Finding a head's Evidence shots (#820)", () => {
  it("finds the run of the named check at the head, and the artifact it uploaded", async () => {
    const client = actions([
      { id: 501, jobs: [{ name: "lint", startedAt: "2026-11-20T01:00:00Z" }] },
      { id: 502, jobs: [{ name: "e2e", startedAt: "2026-11-20T01:00:00Z" }], artifacts: [{ id: 9001, createdAt: "2026-11-20T01:04:00Z" }] },
    ]);

    expect(await find(client)).toEqual({ run: 502, artifact: 9001 });
  });

  it("reads the newest attempt when the check was re-run, never an artifact an earlier attempt uploaded", async () => {
    const reRun = actions([
      {
        id: 502,
        jobs: [{ name: "e2e", startedAt: "2026-11-20T02:00:00Z", attempt: 2 }],
        artifacts: [
          { id: 9001, createdAt: "2026-11-20T01:04:00Z" },
          { id: 9002, createdAt: "2026-11-20T02:04:00Z" },
        ],
      },
    ]);
    const uploadedNone = actions([{ id: 502, jobs: [{ name: "e2e", startedAt: "2026-11-20T02:00:00Z", attempt: 2 }], artifacts: [{ id: 9001, createdAt: "2026-11-20T01:04:00Z" }] }]);

    expect(await find(reRun)).toEqual({ run: 502, artifact: 9002 });
    expect(await find(uploadedNone)).toEqual({ run: 502, artifact: null });
  });

  it("takes the newest run of the check when more than one workflow run at the head ran it", async () => {
    const client = actions([
      { id: 502, jobs: [{ name: "e2e", startedAt: "2026-11-20T01:00:00Z" }], artifacts: [{ id: 9001, createdAt: "2026-11-20T01:04:00Z" }] },
      { id: 503, jobs: [{ name: "e2e", startedAt: "2026-11-20T03:00:00Z" }], artifacts: [{ id: 9003, createdAt: "2026-11-20T03:04:00Z" }] },
    ]);

    expect(await find(client)).toEqual({ run: 503, artifact: 9003 });
  });

  it("finds no artifact when the one the check uploaded has expired", async () => {
    const client = actions([{ id: 502, jobs: [{ name: "e2e", startedAt: "2026-11-20T01:00:00Z" }], artifacts: [{ id: 9001, createdAt: "2026-11-20T01:04:00Z", expired: true }] }]);

    expect(await find(client)).toEqual({ run: 502, artifact: null });
  });

  it("is null when no workflow run at the head ran the check, as for a check outside GitHub Actions", async () => {
    const client = actions([{ id: 501, jobs: [{ name: "e2e (chromium)", startedAt: "2026-11-20T01:00:00Z" }] }]);

    expect(await find(client)).toBeNull();
    expect(client.calls.some((call) => call.includes("/artifacts"))).toBe(false);
  });
});
