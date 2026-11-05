import { describe, expect, it } from "vitest";
import { GitHubError } from "../github/client.ts";
import { storeInstalled } from "./runStore.ts";

/** The REST API as the Fabrik App's JWT sees it: the repos it's installed on. */
function appWith(installedOn: string[], failWith?: number) {
  return {
    async rest(method: string, path: string): Promise<unknown> {
      const installation = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
      if (method !== "GET" || installation === null) throw new Error(`Unexpected call: ${method} ${path}`);
      if (failWith !== undefined) throw new GitHubError(`GET ${path} failed: ${failWith}`, failWith);
      if (!installedOn.includes(installation[1] ?? "")) throw new GitHubError(`GET ${path} failed: 404 Not Found`, 404);
      return { id: 1 };
    },
  };
}

describe("finding the fabrik-runs store", () => {
  it("finds it when the Fabrik App is installed on it", async () => {
    expect(await storeInstalled(appWith(["jrey8343/fabrik-runs"]))).toBe(true);
  });

  it("finds none when the store doesn't exist or the App isn't installed on it: setup isn't done", async () => {
    expect(await storeInstalled(appWith(["jrey8343/product"]))).toBe(false);
  });

  it("fails on anything else, rather than taking it for setup not done", async () => {
    await expect(storeInstalled(appWith([], 500))).rejects.toThrow(/500/);
  });
});
