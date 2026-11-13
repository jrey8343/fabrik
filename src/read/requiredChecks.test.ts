import { describe, expect, it } from "vitest";
import { GitHubError, type ReadClient } from "../github/client.ts";
import { aLabelAdded, anOpenIssue, anOpenPullRequest, aPlainPullRequest, aVerdictComment, factsOf, homeFactsOf } from "./builders.ts";
import { type HeadCheck, headsToCheck, readDefaultBranchRequiredChecks, readRequiredChecks, type RequiredChecksRead, requiredChecksFactOf } from "./requiredChecks.ts";
import { rowsOf } from "./rows.ts";

const NOW = "2026-11-12T10:00:00Z";
const head = (digit: string) => digit.repeat(40);

/** A check run as the Checks API lists it: finished with its conclusion, or still `queued` or `in_progress`. */
interface CannedCheckRun {
  readonly id?: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly startedAt?: string;
  readonly completedAt?: string | null;
}

/** A commit status as the Statuses API lists it. */
interface CannedStatus {
  readonly id?: number;
  readonly context: string;
  readonly state: string;
  readonly at?: string;
  readonly url?: string | null;
}

/** What one head holds: its check runs and commit statuses, either given as a GitHubError failing its read. */
interface CannedHead {
  readonly checkRuns?: readonly CannedCheckRun[] | GitHubError;
  readonly statuses?: readonly CannedStatus[] | GitHubError;
}

/** The default branch's protection, as `GET /repos/{o}/{r}/branches/{b}` gives it, or a GitHubError failing that read. */
type CannedBranch =
  | { readonly protected: false }
  | { readonly protected: true; readonly enforcementLevel: string; readonly required: readonly string[] }
  | GitHubError;

const refusal = (path: string) =>
  new GitHubError(`GitHub GET ${path} failed: 403`, 403, { body: JSON.stringify({ message: "Resource not accessible by integration" }), request: `GET ${path}` });

/** A made-up `owner/product`, default branch `main`, with this protection and these heads; every path it was asked is kept. */
function repoWith(branch: CannedBranch, heads: Readonly<Record<string, CannedHead>> = {}): Pick<ReadClient, "rest"> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      calls.push(path);
      if (path === "/repos/owner/product") return { full_name: "owner/product", default_branch: "main" };
      if (path === "/repos/owner/product/branches/main") {
        if (branch instanceof GitHubError) throw branch;
        if (!branch.protected) return { name: "main", protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } };
        return {
          name: "main",
          protected: true,
          protection: {
            enabled: true,
            required_status_checks: {
              enforcement_level: branch.enforcementLevel,
              contexts: branch.required,
              checks: branch.required.map((context) => ({ context, app_id: null })),
            },
          },
        };
      }
      const runs = /^\/repos\/owner\/product\/commits\/([0-9a-f]{40})\/check-runs\?filter=all&per_page=100&page=1$/.exec(path);
      if (runs !== null) {
        const found = heads[runs[1]!]?.checkRuns ?? [];
        if (found instanceof GitHubError) throw found;
        return {
          total_count: found.length,
          check_runs: found.map((run, index) => ({
            id: run.id ?? index + 1,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion ?? null,
            started_at: run.startedAt ?? "2026-11-12T09:00:00Z",
            completed_at: run.status === "completed" ? (run.completedAt ?? "2026-11-12T09:05:00Z") : null,
            html_url: `https://github.com/owner/product/runs/${run.id ?? index + 1}`,
          })),
        };
      }
      const statuses = /^\/repos\/owner\/product\/commits\/([0-9a-f]{40})\/statuses\?per_page=100&page=1$/.exec(path);
      if (statuses !== null) {
        const found = heads[statuses[1]!]?.statuses ?? [];
        if (found instanceof GitHubError) throw found;
        return found.map((status, index) => ({
          id: status.id ?? 1000 + index,
          context: status.context,
          state: status.state,
          target_url: status.url === undefined ? `https://ci.example.com/${status.id ?? 1000 + index}` : status.url,
          created_at: status.at ?? "2026-11-12T09:05:00Z",
          updated_at: status.at ?? "2026-11-12T09:05:00Z",
        }));
      }
      throw new Error(`Unexpected call: ${path}`);
    },
  };
}

/** A branch held to its rules for everyone, requiring these checks. */
const requiring = (...required: string[]): CannedBranch => ({ protected: true, enforcementLevel: "everyone", required });

/** The names of the checks a head was given, in order. */
function namesOf(checks: readonly HeadCheck[] | "unread" | undefined): string[] | "unread" | undefined {
  return checks === undefined || checks === "unread" ? checks : checks.map(({ name }) => name);
}

/** What each check on one head is, by name. */
async function isOn(client: Pick<ReadClient, "rest">, sha: string): Promise<Record<string, string>> {
  const read = await readRequiredChecks(client, "owner/product", [sha], NOW);
  const checks = read.heads[sha];
  if (checks === undefined || checks === "unread") throw new Error(`head ${sha} was not read`);
  return Object.fromEntries(checks.map(({ name, is }) => [name, is]));
}

describe("the Required checks read", () => {
  describe("judges each Required check on a head as GitHub judges a merge", () => {
    it("passes a check run that concluded success, skipped or neutral", async () => {
      const client = repoWith(requiring("test", "lint", "e2e"), {
        [head("1")]: { checkRuns: [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "skipped" }, { name: "e2e", status: "completed", conclusion: "neutral" }] },
      });

      expect(await isOn(client, head("1"))).toEqual({ test: "passed", lint: "passed", e2e: "passed" });
    });

    it("has a check run queued or in progress, or a status pending, running", async () => {
      const client = repoWith(requiring("test", "lint", "deploy"), {
        [head("1")]: { checkRuns: [{ name: "test", status: "queued" }, { name: "lint", status: "in_progress" }], statuses: [{ context: "deploy", state: "pending" }] },
      });

      expect(await isOn(client, head("1"))).toEqual({ test: "running", lint: "running", deploy: "running" });
    });

    it("fails a check run that concluded failure, cancelled or timed out, and a status of failure or error", async () => {
      const client = repoWith(requiring("test", "lint", "e2e", "deploy", "preview"), {
        [head("1")]: {
          checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }, { name: "lint", status: "completed", conclusion: "cancelled" }, { name: "e2e", status: "completed", conclusion: "timed_out" }],
          statuses: [{ context: "deploy", state: "failure" }, { context: "preview", state: "error" }],
        },
      });

      expect(await isOn(client, head("1"))).toEqual({ test: "failing", lint: "failing", e2e: "failing", deploy: "failing", preview: "failing" });
    });

    it("has a Required check with no report of its name on the head never reported, with no page and no time", async () => {
      const client = repoWith(requiring("test"), { [head("1")]: {} });

      const read = await readRequiredChecks(client, "owner/product", [head("1")], NOW);

      expect(read.heads[head("1")]).toEqual([{ name: "test", is: "never-reported", url: null, at: null }]);
    });
  });

  it("judges a Required check that is a commit status as one that is a check run, with the status's own page and time", async () => {
    const client = repoWith(requiring("ci/build", "ci/deploy"), {
      [head("1")]: { statuses: [{ context: "ci/build", state: "success", at: "2026-11-12T09:07:00Z", url: "https://ci.example.com/build/9" }, { context: "ci/deploy", state: "failure" }] },
    });

    const read = await readRequiredChecks(client, "owner/product", [head("1")], NOW);

    expect(read.heads[head("1")]).toEqual([
      { name: "ci/build", is: "passed", url: "https://ci.example.com/build/9", at: "2026-11-12T09:07:00Z" },
      { name: "ci/deploy", is: "failing", url: "https://ci.example.com/1001", at: "2026-11-12T09:05:00Z" },
    ]);
  });

  it("gives a check run's own page and when it completed, or when it started while it runs", async () => {
    const client = repoWith(requiring("test", "lint"), {
      [head("1")]: { checkRuns: [{ id: 11, name: "test", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:00:00Z", completedAt: "2026-11-12T09:04:00Z" }, { id: 12, name: "lint", status: "in_progress", startedAt: "2026-11-12T09:01:00Z" }] },
    });

    const read = await readRequiredChecks(client, "owner/product", [head("1")], NOW);

    expect(read.heads[head("1")]).toEqual([
      { name: "test", is: "passed", url: "https://github.com/owner/product/runs/11", at: "2026-11-12T09:04:00Z" },
      { name: "lint", is: "running", url: "https://github.com/owner/product/runs/12", at: "2026-11-12T09:01:00Z" },
    ]);
  });

  describe("of several reports of one name on a head, the latest decides", () => {
    const failed = { id: 1, name: "test", status: "completed", conclusion: "failure", startedAt: "2026-11-12T09:00:00Z", completedAt: "2026-11-12T09:04:00Z" } as const;
    const succeeded = { id: 2, name: "test", status: "completed", conclusion: "success", startedAt: "2026-11-12T09:10:00Z", completedAt: "2026-11-12T09:14:00Z" } as const;

    it("a failure then a success is passed", async () => {
      expect(await isOn(repoWith(requiring("test"), { [head("1")]: { checkRuns: [succeeded, failed] } }), head("1"))).toEqual({ test: "passed" });
    });

    it("a success then a failure is failing", async () => {
      const later = { ...failed, id: 3, startedAt: "2026-11-12T09:20:00Z", completedAt: "2026-11-12T09:24:00Z" };

      expect(await isOn(repoWith(requiring("test"), { [head("1")]: { checkRuns: [later, succeeded] } }), head("1"))).toEqual({ test: "failing" });
    });

    it("of statuses too: a pending status followed by a success is passed", async () => {
      const client = repoWith(requiring("ci/build"), {
        [head("1")]: { statuses: [{ id: 2, context: "ci/build", state: "success", at: "2026-11-12T09:09:00Z" }, { id: 1, context: "ci/build", state: "pending", at: "2026-11-12T09:01:00Z" }] },
      });

      expect(await isOn(client, head("1"))).toEqual({ "ci/build": "passed" });
    });
  });

  it("answers for no check the branch does not require, `loop / Kit` among them", async () => {
    const client = repoWith(requiring("test"), {
      [head("1")]: { checkRuns: [{ name: "loop / Kit", status: "completed", conclusion: "failure" }, { name: "test", status: "completed", conclusion: "success" }, { name: "Vercel", status: "in_progress" }], statuses: [{ context: "codecov", state: "failure" }] },
    });

    const read = await readRequiredChecks(client, "owner/product", [head("1")], NOW);

    expect(namesOf(read.heads[head("1")])).toEqual(["test"]);
  });

  it("gives each head in the branch's own order, whatever order the reports came in", async () => {
    const client = repoWith(requiring("lint", "test"), {
      [head("1")]: { checkRuns: [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "success" }] },
    });

    const read = await readRequiredChecks(client, "owner/product", [head("1")], NOW);

    expect(read).toMatchObject({ required: ["lint", "test"] });
    expect(namesOf(read.heads[head("1")])).toEqual(["lint", "test"]);
  });

  it("gives an empty list for each head of a branch that requires nothing", async () => {
    for (const branch of [{ protected: false } as const, { protected: true, enforcementLevel: "off", required: [] } as const]) {
      const client = repoWith(branch, { [head("1")]: { checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }] } });

      const read = await readRequiredChecks(client, "owner/product", [head("1"), head("2")], NOW);

      expect(read.required).toEqual([]);
      expect(read.heads).toEqual({ [head("1")]: [], [head("2")]: [] });
    }
  });

  it("asked about no heads, still gives the branch's own list and whether it holds admins to its rules, with no head read", async () => {
    const client = repoWith(requiring("test", "lint"));

    expect(await readRequiredChecks(client, "owner/product", [], NOW)).toEqual({
      repo: "owner/product",
      branch: "main",
      readAt: NOW,
      required: ["test", "lint"],
      holdsAdmins: "yes",
      heads: {},
    });
    expect(client.calls).toEqual(["/repos/owner/product", "/repos/owner/product/branches/main"]);
  });

  describe("whether the branch holds admins to its rules", () => {
    const holdsAdmins = async (branch: CannedBranch) => (await readRequiredChecks(repoWith(branch), "owner/product", [], NOW)).holdsAdmins;

    it("is yes when its enforcement level is everyone", async () => {
      expect(await holdsAdmins(requiring("test"))).toBe("yes");
    });

    it("is no when its enforcement level is non_admins", async () => {
      expect(await holdsAdmins({ protected: true, enforcementLevel: "non_admins", required: ["test"] })).toBe("no");
    });

    it("is no for a branch with no protection", async () => {
      expect(await holdsAdmins({ protected: false })).toBe("no");
    });

    it("is unknown for a protected branch requiring no checks, whose level reads off whatever it does about admins", async () => {
      expect(await holdsAdmins({ protected: true, enforcementLevel: "off", required: [] })).toBe("unknown");
    });

    it("is unknown when the branch could not be read, every head then unread", async () => {
      const read = await readRequiredChecks(repoWith(refusal("/repos/owner/product/branches/main")), "owner/product", [head("1")], NOW);

      expect(read).toEqual({ repo: "owner/product", branch: "main", readAt: NOW, required: [], holdsAdmins: "unknown", heads: { [head("1")]: "unread" } });
    });
  });

  it("gives a head whose check runs GitHub refused unread, and the rest as read", async () => {
    const client = repoWith(requiring("test"), {
      [head("1")]: { checkRuns: refusal(`/repos/owner/product/commits/${head("1")}/check-runs`) },
      [head("2")]: { checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] },
      [head("3")]: { statuses: new GitHubError("GitHub GET failed: 502", 502) },
    });

    const read = await readRequiredChecks(client, "owner/product", [head("1"), head("2"), head("3")], NOW);

    expect(read.heads[head("1")]).toBe("unread");
    expect(read.heads[head("2")]).toEqual([{ name: "test", is: "passed", url: "https://github.com/owner/product/runs/1", at: "2026-11-12T09:05:00Z" }]);
    expect(read.heads[head("3")]).toBe("unread");
  });

  it("reads each head once, asked twice, in four REST requests for one head", async () => {
    const client = repoWith(requiring("test"), { [head("1")]: {} });

    const read = await readRequiredChecks(client, "owner/product", [head("1"), head("1")], NOW);

    expect(Object.keys(read.heads)).toEqual([head("1")]);
    expect(client.calls).toHaveLength(4);
  });

  it("comes back equal after being written as JSON and read again", async () => {
    const client = repoWith(requiring("test"), { [head("1")]: { checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] }, [head("2")]: { checkRuns: refusal("x") } });

    const read = await readRequiredChecks(client, "owner/product", [head("1"), head("2")], NOW);

    expect(JSON.parse(JSON.stringify(read))).toStrictEqual(read);
  });
});

describe("the default branch's own Required checks, as the Review's wait reads them", () => {
  it("are the branch's own list, in its order, read from the branch alone", async () => {
    const client = repoWith(requiring("b", "a"));

    expect(await readDefaultBranchRequiredChecks(client, "owner/product")).toEqual({ kind: "read", required: ["b", "a"] });
    expect(client.calls).toEqual(["/repos/owner/product", "/repos/owner/product/branches/main"]);
  });

  it("are none for a branch with no protection", async () => {
    expect(await readDefaultBranchRequiredChecks(repoWith({ protected: false }), "owner/product")).toEqual({ kind: "read", required: [] });
  });

  it("are unread when GitHub refuses the branch, saying which request it refused and why", async () => {
    const read = await readDefaultBranchRequiredChecks(repoWith(refusal("/repos/owner/product/branches/main")), "owner/product");

    expect(read).toEqual({ kind: "unread", why: "GET /repos/owner/product/branches/main failed with 403: Resource not accessible by integration" });
  });
});

describe("the Required checks fact of a head, for the Standing rule", () => {
  const read: RequiredChecksRead = {
    repo: "owner/product",
    branch: "main",
    readAt: NOW,
    required: ["test", "lint"],
    holdsAdmins: "yes",
    heads: {
      [head("1")]: [
        { name: "test", is: "passed", url: "https://github.com/owner/product/runs/1", at: "2026-11-12T09:05:00Z" },
        { name: "lint", is: "never-reported", url: null, at: null },
      ],
      [head("2")]: "unread",
      [head("3")]: [],
    },
  };

  it("is each Required check on the head, with when its deciding report was made", () => {
    expect(requiredChecksFactOf(read, head("1"))).toEqual([
      { name: "test", is: "passed", at: "2026-11-12T09:05:00Z" },
      { name: "lint", is: "never-reported", at: null },
    ]);
  });

  it("is an empty list for a head of a branch requiring nothing", () => {
    expect(requiredChecksFactOf(read, head("3"))).toEqual([]);
  });

  it("is unread for a head the read holds as unread, or does not hold", () => {
    expect(requiredChecksFactOf(read, head("2"))).toBe("unread");
    expect(requiredChecksFactOf(read, head("4"))).toBe("unread");
  });
});

describe("the heads a checks read is asked about", () => {
  const passed = (sha: string) => [aVerdictComment("pass", sha, "2026-11-11T20:00:00Z")];

  it("are the heads of agent pull requests at the Merge gate and of open Plain pull requests not in draft, and never a draft agent pull request's", () => {
    const facts = homeFactsOf({
      github: factsOf({
        openIssues: [anOpenIssue({ number: 7, labels: ["ready-for-agent"] }), anOpenIssue({ number: 8, labels: ["ready-for-agent"] })],
        openPullRequests: [
          anOpenPullRequest({ number: 50, ticket: 7, draft: false, headSha: head("1"), comments: passed(head("1")) }),
          anOpenPullRequest({ number: 51, ticket: 8, draft: true, headSha: head("2") }),
        ],
        plainPullRequests: [
          aPlainPullRequest({ number: 70, headSha: head("3") }),
          aPlainPullRequest({ number: 71, headSha: head("4"), draft: true }),
          aPlainPullRequest({ number: 72, headSha: head("5"), mergeable: false }),
        ],
      }),
    });

    expect(headsToCheck(rowsOf(facts, null, null, null, NOW)).toSorted()).toEqual([head("1"), head("3"), head("5")]);
  });

  it("are a Pairing session's pull request's head, joined to its issue's row, unless it is a draft", () => {
    const pairing = (number: number, issue: number, sha: string, draft: boolean) =>
      aPlainPullRequest({ number, author: "operator", headRef: `fabrik/pair-${issue}`, closes: [issue], headSha: sha, draft });
    const triage = (number: number) => anOpenIssue({ number, labels: ["needs-triage"], labelEvents: [aLabelAdded("needs-triage", "2026-11-11T09:00:00Z")] });
    const facts = homeFactsOf({ github: factsOf({ openIssues: [triage(12), triage(13)], plainPullRequests: [pairing(80, 12, head("6"), false), pairing(81, 13, head("7"), true)] }) });
    const rows = rowsOf(facts, null, null, null, NOW);

    expect(rows.map(({ standing }) => [standing.issue, standing.pullRequest, standing.work])).toEqual(
      expect.arrayContaining([
        [12, 80, "issue"],
        [13, 81, "issue"],
      ]),
    );
    expect(headsToCheck(rows)).toEqual([head("6")]);
  });

  it("name each head once", () => {
    const facts = homeFactsOf({ github: factsOf({ plainPullRequests: [aPlainPullRequest({ number: 70 }), aPlainPullRequest({ number: 71 })] }) });

    expect(headsToCheck(rowsOf(facts, null, null, null, NOW))).toEqual(["p".repeat(40)]);
  });
});
