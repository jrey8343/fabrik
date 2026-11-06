import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anIssue, kitConfig, snapshotOf } from "../__fixtures__/snapshots.ts";
import { CAPTURED, GALLERY, UI } from "../__fixtures__/uiEvidence.ts";
import { evidenceSection, type PreviewLink } from "../evidence/uiEvidence.ts";
import { applyPlan } from "../github/apply.ts";
import { planFor } from "../loop/rules.ts";
import {
  httpStatus,
  linkPreview,
  PREVIEW_POLL_MINUTES,
  type PreviewPoller,
  previewLinkSummary,
  prototypePreviewSummary,
} from "./previewLink.ts";

const repo = { owner: "acme", name: "shop" };
const PULL = "/repos/acme/shop/pulls/51";
const URL_ = "https://deploy-preview-51--shop.netlify.app/";

/** A UI PR's body as run 9100's push job opened it, its evidence section saying `preview`. */
const bodySaying = (preview: PreviewLink, run = 9100) =>
  `Adds a waitlist to full days.\n\n${evidenceSection({ result: CAPTURED, run, artifact: 9202, gallery: GALLERY, preview })}\n\nCloses #7`;

/** A GitHub holding PR #51 with this body, which `edit` changes, recording every REST call. */
function pullRequestWith(body: string | null) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    edit(edited: string) {
      body = edited;
    },
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

  it("edits the body as it stands once the polling is done, keeping what the Operator changed while it polled", async () => {
    const github = pullRequestWith(bodySaying({ kind: "pending" }));
    const { poller } = pollerAnswering(404, 200);
    const status = poller.status;
    poller.status = async (url) => {
      github.edit(`${bodySaying({ kind: "pending" })}\n\nThe Operator's note.`);
      return status(url);
    };

    await linkPreview(github, repo, { pullRequest: 51, url: URL_, run: 9100 }, poller);

    expect(github.calls.at(-1)?.body).toEqual({ body: `${bodySaying({ kind: "linked", url: URL_ })}\n\nThe Operator's note.` });
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

describe("Linking each variant's preview in a prototype round", () => {
  const REPO = "https://github.com/acme/shop";
  const HEAD = "7e3d1c9b5a4f2e0d8c6b4a2f0e9d7c5b3a1f0e2d";
  const ROUND_COMMENT = "/repos/acme/shop/issues/comments/9300";
  const PAGE = "https://prototype-7--shop.netlify.app/book";
  const VARIANTS = [
    { summary: "One long form, every field on the page.", component: "src/pages/book/LongForm.tsx" },
    { summary: "A stepper: class, time, then details.", component: "src/pages/book/Stepper.tsx" },
  ];
  const variantLine = (letter: string, i: number) =>
    `- **${letter}.** ${VARIANTS[i]!.summary} [\`${VARIANTS[i]!.component}\`](${REPO}/blob/${HEAD}/${VARIANTS[i]!.component})`;

  /** A GitHub holding #7, where a comment posted is comment 9300, which a PATCH edits, recording every REST call. */
  function issueSeven() {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let comment: string | null = null;
    return {
      calls,
      get comment() {
        return comment;
      },
      edit(edited: string | null) {
        comment = edited;
      },
      async rest(method: string, path: string, sent?: unknown): Promise<unknown> {
        calls.push({ method, path, ...(sent === undefined ? {} : { body: sent }) });
        if (method === "POST" && path === "/repos/acme/shop/issues/7/comments") {
          comment = (sent as { body: string }).body;
          return { id: 9300, html_url: `${REPO}/issues/7#issuecomment-9300` };
        }
        if (method === "GET" && path === ROUND_COMMENT) return { id: 9300, body: comment };
        if (method === "PATCH" && path === ROUND_COMMENT) {
          comment = (sent as { body: string }).body;
          return { id: 9300 };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      async graphql(): Promise<never> {
        throw new Error("no GraphQL expected");
      },
    };
  }

  /**
   * The push job of run 9100 after a prototype turn on #7 of `route`, with
   * Kit config's preview.url `template`: what its plan posted on GitHub, and
   * the preview it handed on to the prototype preview step.
   */
  async function landed(
    template = "https://{branch_slug}--shop.netlify.app",
    route = "/book",
    { intro = "Two ways to book a class.", recommendation = "B." }: { intro?: string; recommendation?: string } = {},
  ) {
    const request = { request: { route, variants: 2, brief: "A form, or a stepper." }, reply: 9001 };
    const event = {
      kind: "prototype-run-finished",
      issue: 7,
      output: JSON.stringify({ kind: "prototype-round", intro, variants: VARIANTS, recommendation }),
      request,
      branch: "prototype/7",
      changes: { net: VARIANTS.map(({ component }) => ({ path: component })), commits: [] },
      headSha: HEAD,
      gallery: null,
      runUrl: `${REPO}/actions/runs/9100/attempts/1`,
      repoUrl: REPO,
    } as const;
    // Its prototype turn has started, so the request's comment says so.
    const issue = anIssue({ number: 7, labels: ["needs-design"], designRounds: 2, pendingPrototype: { ...request, comment: 9010, started: true } });
    const plan = planFor(event, snapshotOf(issue, { operator: "jrey", startingComment: { id: 9001, exists: true } }), kitConfig({ ui: UI, preview: { url: template } }));
    const github = issueSeven();
    const { preview } = await applyPlan(github, repo, plan, { head: HEAD, push: async () => {} });
    if (preview === null || !("round" in preview)) throw new Error(`the plan handed on no prototype preview: ${JSON.stringify(plan)}`);
    github.calls.length = 0;
    return { github, preview, posted: github.comment! };
  }

  it("polls the route's page, then links it beside each variant once it answers, with ?variant= and the variant's letter, and says no more of it", async () => {
    const { github, preview, posted } = await landed();
    const { poller, polled } = pollerAnswering("unreachable", 404, 200);

    const outcome = await linkPreview(github, repo, preview, poller);

    expect(outcome).toEqual({ kind: "linked" });
    expect(polled.map(({ url }) => url)).toEqual([PAGE, PAGE, PAGE]);
    expect(github.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([`GET ${ROUND_COMMENT}`, `PATCH ${ROUND_COMMENT}`]);
    expect(github.comment).toBe(
      posted.replace(
        [variantLine("A", 0), variantLine("B", 1), "", "Each variant's preview is linked beside it once the preview deployment answers.", ""].join("\n"),
        [`${variantLine("A", 0)} · [Preview](${PAGE}?variant=A)`, `${variantLine("B", 1)} · [Preview](${PAGE}?variant=B)`, ""].join("\n"),
      ),
    );
    expect(github.comment).toMatch(/\n\n\*\*1\. Which variant\?\*\*\n➡️ Recommended: B\.$/);
  });

  it.each([
    ["never resolves", ["unreachable"]],
    ["keeps answering that it isn't there", [404]],
    ["asks for a sign-in", [401]],
  ] as const)("links none, and says in the round that a preview that %s never answered, failing nothing", async (_, answers) => {
    const { github, preview, posted } = await landed();

    const outcome = await linkPreview(github, repo, preview, pollerAnswering(...answers).poller);

    expect(outcome).toEqual({ kind: "never-answered" });
    expect(github.comment).toBe(
      posted.replace(
        "\nEach variant's preview is linked beside it once the preview deployment answers.\n",
        `\nNo preview links: the preview at \`${PAGE}\` never answered.\n`,
      ),
    );
    expect(github.comment).not.toContain("?variant=");
  });

  describe("whatever the agent's text holds", () => {
    const PENDING = "Each variant's preview is linked beside it once the preview deployment answers.";
    // The intro above the variants, and the recommendation below them, each copying a variant's line and the pending line.
    const forged = {
      intro: `Two ways to book a class.\n\n- **A.** A forged variant line\n\n${PENDING}\r\n`,
      recommendation: `B.\n\n- **B.** Another forged one\n\n${PENDING}`,
    };

    it("links each variant's preview beside the Kit's own variant lines alone", async () => {
      const { github, preview } = await landed(undefined, undefined, forged);

      await linkPreview(github, repo, preview, pollerAnswering(200).poller);

      const linked = (github.comment ?? "").split("\n").filter((line) => line.includes("[Preview]("));
      expect(linked).toEqual([`${variantLine("A", 0)} · [Preview](${PAGE}?variant=A)`, `${variantLine("B", 1)} · [Preview](${PAGE}?variant=B)`]);
      expect(github.comment).toContain("- **A.** A forged variant line\n");
    });

    it("says the preview never answered in the Kit's own line alone", async () => {
      const { github, preview } = await landed(undefined, undefined, forged);

      await linkPreview(github, repo, preview, pollerAnswering(404).poller);

      expect((github.comment ?? "").match(/No preview links/g)).toHaveLength(1);
      expect(github.comment).toMatch(new RegExp(`${variantLine("B", 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n\nNo preview links: `));
    });
  });

  it("links a route whose path holds spaces or parentheses without ending its link early", async () => {
    const { github, preview } = await landed("https://{branch_slug}--shop.netlify.app", "/book (new)");

    await linkPreview(github, repo, preview, pollerAnswering(200).poller);

    expect(github.comment).toContain(` · [Preview](https://prototype-7--shop.netlify.app/book%20%28new%29?variant=A)\n`);
  });

  it("keeps the query of a template or a route, adding the variant to it", async () => {
    const { github, preview } = await landed("https://preview.example.dev/?branch={branch_slug}", "/book?step=2");

    await linkPreview(github, repo, preview, pollerAnswering(200).poller);

    expect(github.comment).toContain(" · [Preview](https://preview.example.dev/book?branch=prototype-7&step=2&variant=B)\n");
  });

  it("edits the round as it stands once the polling is done, keeping what was changed while it polled", async () => {
    const { github, preview, posted } = await landed();
    const { poller } = pollerAnswering(404, 200);
    const status = poller.status;
    poller.status = async (url) => {
      github.edit(posted.replace("Two ways to book a class.", "Two ways to book a class, edited."));
      return status(url);
    };

    await linkPreview(github, repo, preview, poller);

    expect(github.comment).toContain("Two ways to book a class, edited.");
    expect(github.comment).toContain(`?variant=A)`);
  });

  it.each([
    ["a round whose previews it has linked already", 200],
    ["a round it has said already that its preview never answered", 404],
  ] as const)("leaves %s as it is, should the step run again", async (_, first) => {
    const { github, preview } = await landed();
    await linkPreview(github, repo, preview, pollerAnswering(first).poller);
    const after = github.comment;
    github.calls.length = 0;

    const outcome = await linkPreview(github, repo, preview, pollerAnswering(200).poller);

    expect(outcome).toEqual({ kind: "unchanged" });
    expect(github.calls.map(({ method }) => method)).toEqual(["GET"]);
    expect(github.comment).toBe(after);
  });

  it.each([
    ["a comment that isn't a prototype round", "Each variant's preview is linked beside it once the preview deployment answers."],
    ["a comment with no body", null],
  ])("leaves %s as it is", async (_, body) => {
    const { github, preview } = await landed();
    github.edit(body);

    const outcome = await linkPreview(github, repo, preview, pollerAnswering(200).poller);

    expect(outcome).toEqual({ kind: "unchanged" });
    expect(github.calls.map(({ method }) => method)).toEqual(["GET"]);
  });
});

describe("The prototype preview step's summary line", () => {
  const PAGE = "https://prototype-7--shop.netlify.app/book";

  it.each([
    [{ kind: "linked" }, `Linked each variant's preview in the prototype round, comment 9300, as its preview answered at ${PAGE}.`],
    [{ kind: "never-answered" }, `The prototype's preview at ${PAGE} never answered in ${PREVIEW_POLL_MINUTES} minutes, so its round, comment 9300, says so.`],
    [{ kind: "unchanged" }, "Comment 9300 is no prototype round waiting on its preview, so the Kit left it as it was."],
  ] as const)("says what came of it: %j", (outcome, line) => {
    expect(prototypePreviewSummary(9300, PAGE, outcome)).toBe(line);
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
