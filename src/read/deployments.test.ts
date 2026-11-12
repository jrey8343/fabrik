import { describe, expect, it } from "vitest";
import type { ReadClient } from "../github/client.ts";
import { readDeployments } from "./deployments.ts";

const NOW = "2026-11-12T10:00:00Z";

/** A client that fails the test if anything is asked of it; every path it was asked is kept. */
function askingNothing(): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rest(_method: string, path: string): Promise<unknown> {
      calls.push(path);
      return Promise.reject(new Error(`asked ${path}`));
    },
  };
}

describe("The Deployments read", () => {
  it("makes no request when asked about no merges, and answers for none", async () => {
    const client = askingNothing();
    const read = await readDeployments(client, "owner/product", "production", [], NOW);
    expect(client.calls).toEqual([]);
    expect(read).toEqual({ repo: "owner/product", environment: "production", readAt: NOW, merges: {} });
  });
});
