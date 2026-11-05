import { describe, expect, it } from "vitest";
import { auditMarker, AUDIT_PENDING_MARKER } from "../loop/markers.ts";
import { readAuditInputs, type Reader } from "./inputs.ts";

const repo = { owner: "acme", name: "shop" };
const sha = (c: string) => c.repeat(40);

/** When the tick opened the pending Audit, at the marked commit. */
const OPENED = "2026-11-08T00:00:00Z";
const daysBefore = (days: number) => new Date(Date.parse(OPENED) - days * 86_400_000).toISOString();

/** A filled Audit's body, as the landing writes it (src/loop/auditLanding.ts): its cards, then its Top recommendation. */
const filledBody = (commit: string) =>
  [
    "The Auditor read the default branch up to `aaaaaaa`. File the candidates you want.",
    "",
    "## Split the slot rules out of booking",
    "",
    "`Strong`",
    "",
    "## Top recommendation",
    "",
    "Split the slot rules out of booking.",
    "",
    auditMarker(commit),
  ].join("\n");

/** The Fabrik App's bot, as GraphQL names it: without its [bot] suffix. */
const APP = { login: "fabrik-app", __typename: "Bot" };

/** A `fabrik:audit` issue as GraphQL gives it: the Fabrik App's, filled and closed, unless said otherwise. */
function anAudit(
  number: number,
  {
    commit = sha("a"),
    createdAt = daysBefore(7),
    state = "CLOSED",
    stateReason = state === "CLOSED" ? "COMPLETED" : null,
    body,
    byApp = true,
    author = byApp ? APP : { login: "someone", __typename: "User" },
    title = `Audit: week of ${createdAt.slice(0, 10)}`,
  }: {
    commit?: string;
    createdAt?: string;
    state?: "OPEN" | "CLOSED";
    stateReason?: string | null;
    body?: string;
    byApp?: boolean;
    author?: { login: string; __typename: string };
    title?: string;
  } = {},
) {
  return { number, title, state, stateReason, createdAt, body: body ?? filledBody(commit), author };
}

/** The pending Audit the run is for: #45, marked at sha("b"). */
const pending = anAudit(45, {
  commit: sha("b"),
  createdAt: OPENED,
  state: "OPEN",
  body: `The Auditor is reading the default branch up to bbbbbbb.\n\n${auditMarker(sha("b"))}\n${AUDIT_PENDING_MARKER}`,
});

/** A merged PR as GraphQL gives it: an agent PR (the App's, from an agent branch) unless said otherwise. */
function aMergedPullRequest(number: number, mergedAt: string, { headRefName = `fabrik/ticket-${number - 40}`, byApp = true } = {}) {
  return {
    number,
    title: `PR ${number}`,
    mergedAt,
    updatedAt: mergedAt,
    headRefName,
    author: { __typename: byApp ? "Bot" : "User" },
    mergeCommit: { oid: sha(String(number % 10)) },
  };
}

interface Fake {
  readonly audits?: unknown[];
  readonly merged?: unknown[];
  readonly open?: unknown[];
  /** REST answers by path; a list answers its first page only. */
  readonly rest?: Record<string, unknown>;
}

/** A GitHub that answers the Audit's reads from these lists. */
function gitHub({ audits = [pending], merged = [], open = [], rest = {} }: Fake): Reader {
  const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  return {
    graphql: async <T>(query: string) => {
      if (query.includes("pullRequests(")) return { repository: { pullRequests: page(merged) } } as T;
      if (query.includes("labels:")) return { repository: { issues: { nodes: audits } } } as T;
      return { repository: { issues: page(open) } } as T;
    },
    rest: async (_method: string, path: string) => {
      const [route, query] = path.split("?");
      const value = rest[route ?? ""];
      if (value === undefined) {
        // A PR's files and an issue's comments are empty unless given.
        if (/\/pulls\/\d+\/files$|\/issues\/\d+\/comments$/.test(route ?? "")) return [];
        throw new Error(`unexpected REST call ${path}`);
      }
      if (Array.isArray(value)) return /(^|&)page=1(&|$)/.test(query ?? "") ? value : [];
      return value;
    },
  };
}

const compare = (from: string, to: string, status: string) => ({ [`/repos/acme/shop/compare/${from}...${to}`]: { status } });
const files = (pr: number, ...names: string[]) => ({ [`/repos/acme/shop/pulls/${pr}/files`]: names.map((filename) => ({ filename })) });

const read = (github: Reader) => readAuditInputs(github, repo, { number: 45, commit: sha("b") }, "operator");

describe("The Audit's inputs", () => {
  it("give the hot-spot window from the last Audit's commit to the marked commit, and the agent PRs merged in it", async () => {
    const github = gitHub({
      audits: [pending, anAudit(40, { commit: sha("a"), createdAt: daysBefore(7) })],
      merged: [
        aMergedPullRequest(52, daysBefore(-1)),
        aMergedPullRequest(51, daysBefore(2), { headRefName: "operator/hotfix", byApp: false }),
        aMergedPullRequest(50, daysBefore(3)),
        aMergedPullRequest(48, daysBefore(8)),
      ],
      rest: { ...compare(sha("a"), sha("b"), "ahead"), ...files(50, "src/booking/slots.ts", "src/booking/slots.test.ts") },
    });

    const inputs = await read(github);

    expect(inputs.audit).toEqual({ number: 45, commit: sha("b") });
    expect(inputs.window).toEqual({ kind: "since-audit", audit: 40, commit: sha("a") });
    expect(inputs.pullRequests).toEqual([
      {
        number: 50,
        title: "PR 50",
        mergeCommit: sha("0"),
        headRefName: "fabrik/ticket-10",
        mergedAt: daysBefore(3),
        files: ["src/booking/slots.ts", "src/booking/slots.test.ts"],
      },
    ]);
  });

  // The job holds no App token, so it can't tell the App's bot from another but by the pending Audit's own.
  it("read only the Audits the pending Audit's own bot opened, as the audit gate reads only the App's: another bot's is never the last Audit", async () => {
    const otherBot = { login: "other-app", __typename: "Bot" };
    const github = gitHub({
      audits: [
        pending,
        anAudit(44, { commit: sha("c"), createdAt: daysBefore(2), author: otherBot }),
        anAudit(43, { commit: sha("c"), createdAt: daysBefore(3), state: "OPEN", body: `Reading.\n\n${auditMarker(sha("c"))}\n${AUDIT_PENDING_MARKER}`, author: otherBot }),
        anAudit(40, { commit: sha("a"), createdAt: daysBefore(7) }),
      ],
      rest: { ...compare(sha("a"), sha("b"), "ahead"), ...compare(sha("c"), sha("b"), "ahead") },
    });

    const inputs = await read(github);

    expect(inputs.window).toEqual({ kind: "since-audit", audit: 40, commit: sha("a") });
    expect(inputs.closedAudits.map((audit) => audit.number)).toEqual([40]);
  });

  it("read nothing for a pending Audit a person opened, which is no Audit", async () => {
    const byPerson = { ...pending, author: { login: "fabrik-app", __typename: "User" } };

    await expect(read(gitHub({ audits: [byPerson, anAudit(40, { commit: sha("a") })] }))).rejects.toThrow(
      "Audit #45 isn't an Audit the Fabrik App opened",
    );
  });

  const thirtyDays = { kind: "last-days", days: 30 };
  const lastMonth = [aMergedPullRequest(50, daysBefore(29)), aMergedPullRequest(47, daysBefore(31))];

  it("fall back to the 30 days before the pending Audit on a first run, which a failed Audit or a person's doesn't end", async () => {
    for (const audits of [
      [pending],
      [pending, anAudit(42, { commit: sha("a"), body: `Failed.\n\n${auditMarker(sha("a"))}\n<!-- fabrik:audit-failed -->`, stateReason: "NOT_PLANNED" })],
      [pending, anAudit(41, { commit: sha("a"), byApp: false })],
      [pending, anAudit(40, { body: "An Audit whose body lost its marker." })],
    ]) {
      const inputs = await read(gitHub({ audits, merged: lastMonth }));

      expect(inputs.window).toEqual(thirtyDays);
      expect(inputs.pullRequests.map((pr) => pr.number)).toEqual([50]);
    }
  });

  it.each([
    ["has moved on from it", { status: "diverged" }],
    ["is behind it", { status: "behind" }],
    ["no longer has it", undefined],
  ])("fall back to 30 days when the last Audit's commit isn't an ancestor of the marked one: a force-push that %s", async (_, comparison) => {
    const route = `/repos/acme/shop/compare/${sha("a")}...${sha("b")}`;
    const github = gitHub({ audits: [pending, anAudit(40, { commit: sha("a") })], merged: lastMonth, rest: comparison === undefined ? {} : { [route]: comparison } });
    // GitHub answers 404 for a commit it no longer has.
    const rest = github.rest;
    github.rest = async (method, path, body, options) =>
      comparison === undefined && path.startsWith(route) ? (options?.allowNotFound === true ? null : Promise.reject(new Error("404"))) : rest(method, path, body, options);

    const inputs = await read(github);

    expect(inputs.window).toEqual(thirtyDays);
    expect(inputs.pullRequests.map((pr) => pr.number)).toEqual([50]);
  });

  describe("give the last 3 closed Audits that had candidates", () => {
    const comment = (id: number, login: string, type: string, body: string) => ({
      id,
      user: { login, type },
      body,
      created_at: "2026-11-02T00:00:00Z",
      html_url: `https://github.com/acme/shop/issues/42#issuecomment-${id}`,
    });

    it("with the Operator's comments on each, and nobody else's", async () => {
      const filled = anAudit(42, { commit: sha("a"), stateReason: "NOT_PLANNED" });
      const github = gitHub({
        audits: [pending, filled],
        rest: {
          ...compare(sha("a"), sha("b"), "ahead"),
          "/repos/acme/shop/issues/42/comments": [
            comment(1, "operator", "User", "Not the slot rules: booking owns them on purpose."),
            comment(2, "someone-else", "User", "Do split it."),
            comment(3, "operator", "Bot", "From a bot."),
          ],
        },
      });

      const inputs = await read(github);

      expect(inputs.closedAudits).toEqual([
        {
          number: 42,
          title: `Audit: week of ${daysBefore(7).slice(0, 10)}`,
          commit: sha("a"),
          closedAs: "not_planned",
          body: filledBody(sha("a")),
          operatorComments: [
            {
              url: "https://github.com/acme/shop/issues/42#issuecomment-1",
              createdAt: "2026-11-02T00:00:00Z",
              body: "Not the slot rules: booking owns them on purpose.",
            },
          ],
        },
      ]);
    });

    it("newest first, leaving out a clean Audit, a failed one, one cancelled while pending, and a person's", async () => {
      const closed = (number: number, days: number, options: Parameters<typeof anAudit>[1] = {}) =>
        anAudit(number, { createdAt: daysBefore(days), ...options });
      const audits = [
        pending,
        closed(44, 7, { body: `The Auditor found nothing above Speculative: the repo is clean.\n\n${auditMarker(sha("a"))}` }),
        closed(43, 14, { stateReason: "NOT_PLANNED", body: `Failed.\n\n${auditMarker(sha("c"))}\n<!-- fabrik:audit-failed -->` }),
        closed(42, 21, { body: `Reading.\n\n${auditMarker(sha("c"))}\n${AUDIT_PENDING_MARKER}` }),
        closed(41, 28, { byApp: false }),
        closed(40, 35),
        closed(39, 42),
        closed(38, 49),
        closed(37, 56),
      ];

      const inputs = await read(gitHub({ audits, rest: compare(sha("a"), sha("b"), "ahead") }));

      expect(inputs.closedAudits.map((audit) => audit.number)).toEqual([40, 39, 38]);
    });
  });

  it("give the comprehension drift over the 30 days before the pending Audit, however long the window", async () => {
    const hot = (number: number, days: number) => ({ pr: aMergedPullRequest(number, daysBefore(days)), files: files(number, "src/booking/slots.ts") });
    for (const [lastAuditDays, inWindow] of [
      [7, [61, 60]],
      [60, [61, 60, 59, 58, 57, 56, 50]],
    ] as const) {
      const prs = [hot(61, 1), hot(60, 3), hot(59, 9), hot(58, 12), hot(57, 20), hot(56, 29), hot(50, 45)];
      const github = gitHub({
        audits: [pending, anAudit(40, { commit: sha("a"), createdAt: daysBefore(lastAuditDays) })],
        merged: prs.map(({ pr }) => pr),
        rest: { ...compare(sha("a"), sha("b"), "ahead"), ...Object.assign({}, ...prs.map(({ files }) => files)) },
      });

      const inputs = await read(github);

      expect(inputs.drift).toEqual([{ path: "src/booking/slots.ts", changes: 6 }]);
      expect(inputs.pullRequests.map((pr) => pr.number)).toEqual(inWindow);
    }
  });

  it("give the open issues filed from an Audit, by their From audit line, with their titles and bodies", async () => {
    const issue = (number: number, body: string) => ({ number, title: `Issue ${number}`, body });
    const github = gitHub({
      open: [
        issue(60, "Split the slot rules out of booking.\n\nFrom audit #40\n<!-- fabrik:escape strong #50 -->"),
        issue(61, "Booking and billing share one module, as From audit #40 said."),
        issue(62, "> From audit #40"),
        issue(63, "Rename the invoice module.\n\n  From audit #38  "),
        issue(64, "Add a waitlist."),
        // A Monitor issue fences the Sentry error title it quotes, which the app wrote.
        issue(65, "<!-- fabrik:monitor sentry:4504 -->\n## Error\n\n```\nFrom audit #40\n```"),
      ],
    });

    const inputs = await read(github);

    expect(inputs.filedCandidates).toEqual([
      { number: 60, title: "Issue 60", fromAudit: 40, body: "Split the slot rules out of booking.\n\nFrom audit #40\n<!-- fabrik:escape strong #50 -->" },
      { number: 63, title: "Issue 63", fromAudit: 38, body: "Rename the invoice module.\n\n  From audit #38  " },
    ]);
  });
});
