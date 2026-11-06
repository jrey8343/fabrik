import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTURED, GALLERY } from "../__fixtures__/uiEvidence.ts";
import { evidenceSection, type PreviewLink } from "../evidence/uiEvidence.ts";
import { httpStatus, linkPreview, PREVIEW_POLL_MINUTES, type PreviewPoller, previewLinkSummary } from "./previewLink.ts";

const repo = { owner: "acme", name: "shop" };
const PULL = "/repos/acme/shop/pulls/51";
const URL_ = "https://deploy-preview-51--shop.netlify.app/";

/** A UI PR's body as run 9100's push job opened it, its evidence section saying `preview`. */
const bodySaying = (preview: PreviewLink, run = 9100) =>
  `Adds a waitlist to full days.\n\n${evidenceSection({ result: CAPTURED, run, artifact: 9202, gallery: GALLERY, preview })}\n\nCloses #7`;

/** A GitHub holding PR #51 with this body, recording every REST call. */
function pullRequestWith(body: string | null) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    async rest(method: string, path: string, sent?: unknown): Promise<unknown> {
      calls.push({ method, path, ...(sent === undefined ? {} : { body: sent }) });
      if (method === "GET" && path === PULL) return { number: 51, body };
      if (method === "PATCH" && path === PULL) return { number: 51 };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

/** A clock that only moves when the poller waits, and a preview that answers each poll with the next of `answers`, the last one for good. */
function pollerAnswering(...answers: (number | "unreachable")[]) {
  let now = Date.UTC(2026, 10, 6, 4, 0);
  const start = now;
  const polled: { url: string; at: number }[] = [];
  const poller: PreviewPoller = {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    status: async (url) => {
      polled.push({ url, at: now - start });
      const answer = answers[Math.min(polled.length - 1, answers.length - 1)];
      if (answer === "unreachable" || answer === undefined) throw new Error("getaddrinfo ENOTFOUND deploy-preview-51--shop.netlify.app");
      return answer;
    },
  };
  return { poller, polled };
}

const BUDGET_MS = PREVIEW_POLL_MINUTES * 60_000;

describe("Linking a UI PR's preview deployment", () => {
  it("links the preview in the PR's evidence section once it answers, polling it until then", async () => {
    const github = pullRequestWith(bodySaying({ kind: "pending" }));
    const { poller, polled } = pollerAnswering("unreachable", 404, 503, 200);

    const outcome = await linkPreview(github, repo, { pullRequest: 51, url: URL_, run: 9100 }, poller);

    expect(outcome).toEqual({ kind: "linked" });
    expect(polled.map(({ url }) => url)).toEqual([URL_, URL_, URL_, URL_]);
    expect(github.calls).toEqual([
      { method: "GET", path: PULL },
      { method: "PATCH", path: PULL, body: { body: bodySaying({ kind: "linked", url: URL_ }) } },
    ]);
  });

  it.each([
    ["never resolves", ["unreachable"]],
    ["keeps answering that it isn't there", [404]],
    ["keeps answering with a server error", [502]],
    ["asks for a sign-in", [401]],
  ] as const)("says in the evidence section that a preview that %s never answered, and fails nothing", async (_, answers) => {
    const github = pullRequestWith(bodySaying({ kind: "pending" }));
    const { poller } = pollerAnswering(...answers);

    const outcome = await linkPreview(github, repo, { pullRequest: 51, url: URL_, run: 9100 }, poller);

    expect(outcome).toEqual({ kind: "never-answered" });
    expect(github.calls.at(-1)).toEqual({ method: "PATCH", path: PULL, body: { body: bodySaying({ kind: "never-answered", url: URL_ }) } });
  });

  it(`stops polling after ${PREVIEW_POLL_MINUTES} minutes, a Kit constant within the push job's step's timeout, polling one last time at the end`, async () => {
    const { poller, polled } = pollerAnswering(404);

    await linkPreview(pullRequestWith(bodySaying({ kind: "pending" })), repo, { pullRequest: 51, url: URL_, run: 9100 }, poller);

    expect(polled.length).toBeGreaterThan(4);
    expect(polled.at(-1)?.at).toBe(BUDGET_MS);
    expect(polled.every(({ at }) => at <= BUDGET_MS)).toBe(true);
  });

  it("reads the body only once it has polled, so it edits the body as it then stands", async () => {
    const github = pullRequestWith(bodySaying({ kind: "pending" }));
    const { poller } = pollerAnswering(404, 200);
    const status = poller.status;
    let readBeforeAnswer = false;
    poller.status = async (url) => {
      readBeforeAnswer ||= github.calls.length > 0;
      return status(url);
    };

    await linkPreview(github, repo, { pullRequest: 51, url: URL_, run: 9100 }, poller);

    expect(readBeforeAnswer).toBe(false);
  });

  it.each([
    ["a later run's section", bodySaying({ kind: "pending" }, 9300)],
    ["a section that already says what came of the preview", bodySaying({ kind: "linked", url: URL_ })],
    ["no evidence section", "Adds a waitlist to full days.\n\nCloses #7"],
    ["no body at all", null],
  ])("leaves a body holding %s as it is", async (_, body) => {
    const github = pullRequestWith(body);

    const outcome = await linkPreview(github, repo, { pullRequest: 51, url: URL_, run: 9100 }, pollerAnswering(200).poller);

    expect(outcome).toEqual({ kind: "unchanged" });
    expect(github.calls.map(({ method }) => method)).toEqual(["GET"]);
  });
});

describe("The preview step's summary line", () => {
  it.each([
    [{ kind: "linked" }, `Linked #51's preview deployment, which answered at ${URL_}.`],
    [{ kind: "never-answered" }, `#51's preview at ${URL_} never answered in ${PREVIEW_POLL_MINUTES} minutes, so its evidence section says so.`],
    [{ kind: "unchanged" }, "#51's body holds no evidence section of this run waiting on its preview, so the Kit left it as it was."],
  ] as const)("says what came of it: %j", (outcome, line) => {
    expect(previewLinkSummary(51, URL_, outcome)).toBe(line);
  });
});

describe("Polling a preview over HTTP", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/moved") response.writeHead(302, { location: "/page" }).end();
      else if (request.url === "/page") response.writeHead(200, { "content-type": "text/html" }).end("<p>The waitlist</p>");
      else if (request.url === "/building") response.writeHead(404).end("Not found");
      // /hangs never answers.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("follows a redirect to the page it lands on, as the Operator's browser would", async () => {
    expect(await httpStatus(`${base}/moved`)).toBe(200);
  });

  it("reads the status a preview still building answers with", async () => {
    expect(await httpStatus(`${base}/building`)).toBe(404);
  });

  it("gives up on a preview that never answers, so one poll can't outlast its share of the budget", async () => {
    await expect(httpStatus(`${base}/hangs`, 50)).rejects.toThrow();
  });
});
