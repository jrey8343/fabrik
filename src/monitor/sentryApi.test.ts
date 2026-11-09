import { afterEach, describe, expect, it, vi } from "vitest";
import { SENTRY_ON } from "../__fixtures__/monitor.ts";
import { readSentry } from "./sentryApi.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Reading Sentry", () => {
  it.each([401, 403] as const)("gives a rejected token (%i) as such, with a ::warning annotation, as any other Sentry error has", async (status) => {
    vi.stubGlobal("fetch", async () => new Response("Invalid token", { status }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const read = await readSentry(SENTRY_ON, "revoked-token");

    expect(read).toEqual({ kind: "token-rejected", status });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `::warning title=Sentry token rejected::Sentry answered GET /api/0/projects/acme/clinic/issues/ with ${status}: Invalid token`,
    ]);
  });
});
