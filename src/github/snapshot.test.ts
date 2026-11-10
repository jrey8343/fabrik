import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { GitHub } from "./client.ts";
import {
  anIssue,
  aPullRequest,
  AUDITED_SHA,
  auditBody,
  designQueueSnapshotOf,
  HEAD_SHA,
  kitConfig,
  notificationsOf,
  RETRO_WINDOW_END,
  retroBody,
  snapshotOf,
  snapshotOfPullRequest,
} from "../__fixtures__/snapshots.ts";
import { aReading, acceptedBody } from "../__fixtures__/replay.ts";
import { UI } from "../__fixtures__/uiEvidence.ts";
import { aRunRecord } from "../__fixtures__/weeklySummary.ts";
import { type CaptureResult, evidenceSection } from "../evidence/uiEvidence.ts";
import type { RunRecord } from "../kit/runRecord.ts";
import { DEFAULT_KIT_CONFIG, resolveKitConfig } from "../kit/config.ts";
import { JUDGE_JOB } from "../kit/judge.ts";
import { changedTestsSection } from "../loop/changedTests.ts";
import { holdsSlot } from "../loop/designQueue.ts";
import { DESIGN_TURN_FAILED_MARKER, EMPTY_DIFF_MARKER, IMPLEMENT_RUN_FAILED_MARKER, RESEARCH_RUN_FAILED_MARKER } from "../loop/markers.ts";
import { planFor } from "../loop/rules.ts";
import type { DesignQueueSnapshot, LoopEvent, Plan } from "../loop/types.ts";
import {
  countDispatchedRuns,
  DESIGN_JOB_NAME,
  designTurnsInProgress,
  gatherSnapshot as gatherFrom,
  IMPLEMENT_JOB_NAME,
  MERGEABLE_READS,
  MERGEABLE_WAIT_MS,
  PROTOTYPE_JOB_NAME,
  PUSH_JOB_NAME,
  readKitConfigSources,
  RESEARCH_JOB_NAME,
  REVIEW_CHECKS_JOB_NAME,
  REVIEW_JOB_NAME,
  CLAIM_JOB_NAME,
} from "./snapshot.ts";

/** The conflict check's query (#304), which reads each open PR's mergeable state. */
const isConflictsQuery = (query: string) => /pullRequests\(states: OPEN[^]*\bmergeable\b/.test(query);

/** Marks a fake GitHub as answering the conflict check's query itself. */
const ANSWERS_CONFLICTS = Symbol("answers the conflict check's query");

/**
 * gatherSnapshot, where a fake GitHub not marked as answering the conflict
 * check's query, as every one written before it, reads as a repo with no
 * open PR. Its retries wait no time.
 */
function gatherSnapshot(github: GitHub, ...rest: Parameters<typeof gatherFrom> extends [unknown, ...infer R] ? R : never) {
  const answering =
    ANSWERS_CONFLICTS in github
      ? github
      : ({
          ...github,
          async graphql(query: string, variables: Record<string, unknown>) {
            if (isConflictsQuery(query)) return { repository: { defaultBranchRef: null, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
            return github.graphql(query, variables);
          },
        } as unknown as GitHub);
  const [repoArg, event, operator, appLogin, actions = null, store = null, replayStore = null, wait = async () => undefined] = rest;
  return gatherFrom(answering, repoArg, event, operator, appLogin, actions, store, replayStore, wait);
}

const repo = { owner: "acme", name: "shop" };

/** A read-only Actions API holding these workflow runs, each with its jobs. */
function actionsWith(runs: { id: number; status: string; jobs: { name: string; status: string; conclusion?: string }[] }[]) {
  return {
    async rest(method: string, path: string): Promise<unknown> {
      expect(method).toBe("GET");
      const listed = /^\/repos\/acme\/shop\/actions\/runs\?status=(\w+)&per_page=100$/.exec(path);
      if (listed !== null) return { workflow_runs: runs.filter((run) => run.status === listed[1]).map(({ id }) => ({ id })) };
      const jobs = /^\/repos\/acme\/shop\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(path);
      if (jobs !== null) return { jobs: runs.find((run) => run.id === Number(jobs[1]))?.jobs ?? [] };
      throw new Error(`Unexpected call: ${path}`);
    },
  };
}

describe("Counting the Implement runs a Dispatch check sees in flight", () => {
  it("counts a running Implement job, called from a Product repo's caller workflow", async () => {
    const actions = actionsWith([{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "in_progress" }] }]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 1, research: 0 });
  });

  // #477: the job names its Ticket, and a retry its Retry number; a run of an earlier Kit release names neither.
  it("counts an Implement job named for its Ticket, a retry's named for its Retry too, as it counts one of an earlier Kit release", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement #12", status: "in_progress" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement #14 (Retry 1)", status: "queued" }] },
      { id: 3, status: "in_progress", jobs: [{ name: "Implement #15", status: "in_progress" }] },
      { id: 4, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "in_progress" }] },
      { id: 5, status: "in_progress", jobs: [{ name: "fabrik / Replay implement (baseline)", status: "in_progress" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 4, research: 0 });
  });

  it("counts an Implement job still queued or waiting after its claim took agent:implement off the Ticket", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Claim the work", status: "completed" }, { name: "fabrik / Implement", status: "queued" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "waiting" }] },
      { id: 3, status: "queued", jobs: [{ name: "fabrik / Implement", status: "queued" }] },
      { id: 4, status: "waiting", jobs: [{ name: "fabrik / Implement", status: "pending" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 4, research: 0 });
  });

  // #432: the claim took the label off and the draft PR isn't open yet, so the run is all that holds the slot.
  it("counts an Implement job that's done while its run's push job is still to land it", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed", conclusion: "success" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed", conclusion: "failure" }, { name: "fabrik / Push", status: "in_progress" }] },
      { id: 3, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed", conclusion: "success" }, { name: "fabrik / Push", status: "queued" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 3, research: 0 });
  });

  it("doesn't count an Implement job once its run's push job has landed it, one its run skipped, or any other job", async () => {
    const actions = actionsWith([
      {
        id: 1,
        status: "in_progress",
        jobs: [
          { name: "fabrik / Implement", status: "completed", conclusion: "success" },
          { name: "fabrik / Push", status: "completed", conclusion: "success" },
          { name: "fabrik / Dispatch", status: "in_progress" },
        ],
      },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed", conclusion: "skipped" }, { name: "fabrik / Review", status: "in_progress" }] },
      { id: 3, status: "in_progress", jobs: [{ name: "fabrik / Implement failed", status: "in_progress" }] },
      { id: 4, status: "completed", jobs: [{ name: "fabrik / Implement", status: "completed", conclusion: "success" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 0, research: 0 });
  });
});

describe("Counting the Research runs a Dispatch check sees in flight", () => {
  it("counts a Research job running, queued or waiting, called from a Product repo's caller workflow or not, beside the Implement jobs", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Research", status: "in_progress" }, { name: "fabrik / Implement", status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: "fabrik / Research", status: "queued" }] },
      { id: 3, status: "waiting", jobs: [{ name: "Research", status: "waiting" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 1, research: 3 });
  });

  it("doesn't count a finished Research job, or any other job", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Research", status: "completed" }, { name: "fabrik / Push", status: "in_progress" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Retro evidence", status: "in_progress" }, { name: "fabrik / Research failed", status: "in_progress" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 0, research: 0 });
  });
});

describe("The Implement job's name", () => {
  it("is the name loop.yml gives the Implement job, followed by its Ticket and a retry's Retry number, which Dispatch counts by (#477)", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const implementJob = /^ {2}implement:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    // Quoted, since an unquoted ` #` starts a YAML comment.
    expect(implementJob).toBe(
      `"${IMPLEMENT_JOB_NAME} #\${{ needs.kit.outputs.ticket }}\${{ needs.kit.outputs.retry != '0' && needs.kit.outputs.retry != '' && format(' (Retry {0})', needs.kit.outputs.retry) || '' }}"`,
    );
  });
});

describe("The push job's name", () => {
  it("is the name loop.yml gives the push job, which an Implement job counts as under way until it lands", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const pushJob = /^ {2}push:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    expect(pushJob).toBe(PUSH_JOB_NAME);
  });
});

describe("The Research job's name", () => {
  it("is the name loop.yml gives the Research job, which Dispatch counts Research runs by", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const researchJob = /^ {2}research:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    expect(researchJob).toBe(RESEARCH_JOB_NAME);
  });
});

describe("The judge job's name", () => {
  // #149: scoring never takes a Dispatch slot, nor a Design session slot.
  it("is never counted as an Implement run, a Research run or a Design-session turn in flight while it scores a run", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const judgeJob = new RegExp(`^ {2}${JUDGE_JOB}:\n {4}name: (.+)$`, "m").exec(workflow)?.[1];
    expect(judgeJob).toBeDefined();
    const actions = actionsWith([
      {
        id: 1,
        status: "in_progress",
        jobs: [
          { name: "fabrik / Implement", status: "completed", conclusion: "success" },
          { name: "fabrik / Push", status: "completed", conclusion: "success" },
          { name: `fabrik / ${judgeJob}`, status: "in_progress" },
        ],
      },
      { id: 2, status: "queued", jobs: [{ name: `fabrik / ${judgeJob}`, status: "queued" }] },
    ]);

    expect(await countDispatchedRuns(actions, repo)).toEqual({ implement: 0, research: 0 });
    expect(await designTurnsInProgress(actions, repo)).toEqual([]);
  });
});

describe("Reading the Design-session turns a Design queue check sees in progress", () => {
  it("reads the issue of each Design-session turn running, queued or waiting, from its job's name", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Design-session turn #7", status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: "fabrik / Design-session turn #9", status: "queued" }] },
      { id: 3, status: "waiting", jobs: [{ name: "Design-session turn #4", status: "waiting" }] },
    ]);

    expect(await designTurnsInProgress(actions, repo)).toEqual([4, 7, 9]);
  });

  it("reads a Design-session turn whose job is done while its run is still posting the round", async () => {
    const actions = actionsWith([
      {
        id: 1,
        status: "in_progress",
        jobs: [
          { name: "fabrik / Design-session turn #7", status: "completed", conclusion: "success" },
          { name: "fabrik / Push", status: "in_progress" },
        ],
      },
    ]);

    expect(await designTurnsInProgress(actions, repo)).toEqual([7]);
  });

  it("reads a session's prototype turn running, queued or waiting as its Design-session turn in progress", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Design-session turn #7", status: "completed", conclusion: "skipped" }, { name: "fabrik / Prototype turn #7", status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: "fabrik / Prototype turn #9", status: "queued" }] },
      { id: 3, status: "in_progress", jobs: [{ name: "Prototype turn #4", status: "completed", conclusion: "success" }, { name: "Push", status: "in_progress" }] },
    ]);

    expect(await designTurnsInProgress(actions, repo)).toEqual([4, 7, 9]);
  });

  it("doesn't read a Design job skipped because its run went another way, or any other job", async () => {
    const actions = actionsWith([
      {
        id: 1,
        status: "in_progress",
        jobs: [
          { name: "fabrik / Design-session turn #7", status: "completed", conclusion: "skipped" },
          { name: "fabrik / Implement", status: "in_progress" },
          { name: "fabrik / Design-session turn #", status: "in_progress" },
        ],
      },
    ]);

    expect(await designTurnsInProgress(actions, repo)).toEqual([]);
  });
});

describe("The Design-session turn job's name", () => {
  it("is the name loop.yml gives the Design job, followed by its issue, which a Design queue check reads", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const designJob = /^ {2}design:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    // Quoted, since an unquoted ` #` starts a YAML comment.
    expect(designJob).toBe(`"${DESIGN_JOB_NAME} #\${{ github.event.issue.number }}"`);
  });

  it("has a prototype twin: the name loop.yml gives the prototype job, followed by its issue, which a Design queue check reads too", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");
    const prototypeJob = /^ {2}prototype:\n {4}name: (.+)$/m.exec(workflow)?.[1];

    expect(prototypeJob).toBe(`"${PROTOTYPE_JOB_NAME} #\${{ github.event.issue.number }}"`);
  });
});

describe("Gathering a Design queue check's needs-design issues", () => {
  const kit = (body: string, createdAt = "2026-11-02T09:00:00Z") => ({ body, createdAt, author: APP_BOT });
  const person = (body: string, createdAt = "2026-11-02T09:00:00Z") => ({ body, createdAt, author: { login: "jrey", __typename: "User" } });
  const otherBot = (body: string, createdAt = "2026-11-02T09:00:00Z") => ({ body, createdAt, author: { login: "dependabot", __typename: "Bot" } });
  const labelled = (name: string, createdAt: string) => ({ __typename: "LabeledEvent", createdAt, label: { name } });
  const unlabelled = (name: string, createdAt: string, actor = "Bot") => ({
    __typename: "UnlabeledEvent",
    createdAt,
    label: { name },
    actor: { __typename: actor },
  });

  function issue(number: number, overrides: Record<string, unknown> = {}) {
    return {
      number,
      createdAt: "2026-10-01T09:00:00Z",
      labels: { nodes: [{ name: "needs-design" }] },
      comments: { nodes: [] },
      timelineItems: { nodes: [labelled("needs-design", "2026-11-01T09:00:00Z")] },
      ...overrides,
    };
  }

  async function gathered(
    nodes: unknown[],
    runs: Parameters<typeof actionsWith>[0] | null = [],
    appLogin: string | null = null,
  ): Promise<DesignQueueSnapshot> {
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("labels: [$needsDesign]")) {
          expect(variables["needsDesign"]).toBe("needs-design");
          return {
            repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    const actions = runs === null ? null : (actionsWith(runs) as unknown as GitHub);
    const snapshot = await gatherSnapshot(github, repo, { kind: "design-queue-check" }, null, appLogin, actions);
    if (snapshot.designQueue === null) throw new Error("no Design queue slice");
    return snapshot.designQueue;
  }

  function holding(queue: DesignQueueSnapshot): Record<number, boolean> {
    return Object.fromEntries(queue.issues.map((i) => [i.number, holdsSlot(i, queue)]));
  }

  it("reads an issue with a posted round, a turn in progress or a failed turn as holding a slot, and one with none as waiting", async () => {
    const queue = await gathered(
      [
        issue(3, { comments: { nodes: [kit("<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.**"), person("yes")] } }),
        issue(4),
        issue(5, { comments: { nodes: [kit("<!-- fabrik:design-turn-failed -->\n@jrey The Design-session turn run on #5 failed.")] } }),
        issue(6, { comments: { nodes: [person("Any news?")] } }),
      ],
      [{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Design-session turn #4", status: "in_progress" }] }],
    );

    expect(queue.designTurnsInProgress).toEqual([4]);
    expect(holding(queue)).toEqual({ 3: true, 4: true, 5: true, 6: false });
  });

  it("reads a round or a failed turn only from the Fabrik App's comments, so nobody, another bot included, can take a slot by forging one (#426)", async () => {
    const round = "<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.**";
    const failed = "<!-- fabrik:design-turn-failed -->\n@jrey The Design-session turn run failed.";
    const queue = await gathered(
      [
        issue(3, { comments: { nodes: [kit(round)] } }),
        issue(4, { comments: { nodes: [person(round), otherBot(round)] } }),
        issue(5, { comments: { nodes: [person(failed), otherBot(failed)] } }),
      ],
      [],
      APP_LOGIN,
    );

    expect(holding(queue)).toEqual({ 3: true, 4: false, 5: false });
    expect(queue.issues.map(({ number, designRounds }) => [number, designRounds])).toEqual([[3, 1], [4, 0], [5, 0]]);
  });

  it("reads a session whose first turn asked for a Prototype as holding its slot until the prototype turn lands, so the cap holds", async () => {
    const firstTurn = planFor(
      {
        kind: "agent-run-finished",
        role: "design",
        issue: 3,
        output: JSON.stringify({ kind: "prototype", route: "/book", variants: 3, brief: "Three layouts.", comment: "Prototyping the booking page." }),
      },
      snapshotOf(anIssue({ number: 3, labels: ["needs-design"] })),
      kitConfig({ ui: UI }),
    );
    if (firstTurn.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(firstTurn)}`);
    const request = firstTurn.actions.flatMap((action) => (action.kind === "comment" ? [kit(action.body)] : []));
    expect(request).toHaveLength(1);
    const asked = (runs: Parameters<typeof actionsWith>[0]) =>
      gathered(
        [
          issue(3, {
            comments: { nodes: request },
            timelineItems: { nodes: [labelled("needs-design", "2026-11-01T09:00:00Z"), unlabelled("agent:design", "2026-11-02T10:00:00Z")] },
          }),
          issue(4),
        ],
        runs,
      );
    const checked = (queue: DesignQueueSnapshot) =>
      planFor(
        { kind: "design-queue-check" },
        designQueueSnapshotOf(queue.issues, { designTurnsInProgress: queue.designTurnsInProgress }),
        kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 1 } }),
      );

    for (const queue of [
      // The prototype turn queued, then running, then done while its push job posts the round.
      await asked([{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Design-session turn #3", status: "completed", conclusion: "skipped" }, { name: "fabrik / Prototype turn #3", status: "queued" }] }]),
      await asked([{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Prototype turn #3", status: "in_progress" }] }]),
      await asked([{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Prototype turn #3", status: "completed", conclusion: "success" }, { name: "fabrik / Push", status: "in_progress" }] }]),
    ]) {
      expect(holding(queue)).toEqual({ 3: true, 4: false });
      expect(checked(queue)).toMatchObject({ kind: "nothing", reason: expect.stringContaining("#3 holds a slot") });
    }
  });

  it("reads an issue that got needs-design again, after its old session was abandoned by hand, as waiting", async () => {
    const queue = await gathered([
      issue(3, {
        comments: {
          nodes: [
            kit("<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.**", "2026-10-02T09:00:00Z"),
            person("Can we add a cart total?", "2026-11-02T09:00:00Z"),
          ],
        },
        timelineItems: {
          nodes: [
            labelled("needs-design", "2026-10-01T09:00:00Z"),
            unlabelled("needs-design", "2026-10-03T09:00:00Z", "User"),
            labelled("needs-design", "2026-11-01T09:00:00Z"),
          ],
        },
      }),
      issue(4, {
        comments: { nodes: [kit("<!-- fabrik:design-turn-failed -->\n@jrey The Design-session turn run on #4 failed.", "2026-10-02T09:00:00Z")] },
        timelineItems: {
          nodes: [
            labelled("needs-design", "2026-10-01T09:00:00Z"),
            unlabelled("needs-design", "2026-10-03T09:00:00Z", "User"),
            labelled("needs-design", "2026-11-01T09:00:00Z"),
          ],
        },
      }),
      issue(5, {
        comments: { nodes: [kit("<!-- fabrik:design-round 1 -->\n@jrey **Design session, round 1.**", "2026-11-02T09:00:00Z")] },
      }),
    ]);

    expect(holding(queue)).toEqual({ 3: false, 4: false, 5: true });
  });

  it("reads when an issue got needs-design from its label timeline: the latest time it was added", async () => {
    const queue = await gathered([
      issue(3, {
        timelineItems: {
          nodes: [
            labelled("needs-design", "2026-11-01T09:00:00Z"),
            labelled("bug", "2026-11-02T09:00:00Z"),
            labelled("needs-design", "2026-11-03T09:00:00Z"),
            {},
          ],
        },
      }),
    ]);

    expect(queue.issues).toEqual([
      { number: 3, labels: ["needs-design"], designRounds: 0, turnFailed: false, redesign: false, neededDesignAt: "2026-11-03T09:00:00Z" },
    ]);
  });

  describe("reading a re-design", () => {
    const RUN = "https://github.com/acme/shop/actions/runs/42/attempts/1";
    const reviewed = (output: string): LoopEvent => ({
      kind: "review-run-finished",
      pullRequest: 50,
      headSha: HEAD_SHA,
      output,
      runUrl: RUN,
      repoUrl: "https://github.com/acme/shop",
    });
    const earlier = (source: "reviewer" | "ci") => ({
      verdict: "execution-flaw" as const,
      source,
      requestChanges: false,
      headSha: "0".repeat(40),
    });
    const changedNothing: LoopEvent = {
      kind: "implement-run-finished",
      runUrl: "https://github.com/acme/shop/actions/runs/1/attempts/1",
      issue: 7,
      output: JSON.stringify({ title: "Handle the empty cart", summary: "Nothing to change." }),
      branch: "fabrik/ticket-7",
      base: "main",
      changes: { net: [], commits: [] },
    };

    /** The comments a plan posts on the Ticket, #7, as the Kit posts them, with any link to another comment filled in. */
    function ticketCommentsOf(plan: Plan): { body: string; author: { __typename: string } }[] {
      if (plan.kind !== "act") throw new Error(`expected a plan that acts, got ${JSON.stringify(plan)}`);
      return plan.actions.flatMap((action) => {
        if (action.kind === "comment" && action.issue === 7) return [kit(action.body)];
        if (action.kind === "comment-linking" && action.issue === 7) {
          return [kit(action.body.map((part) => (typeof part === "string" ? part : "https://github.com/acme/shop/pull/50#issuecomment-1")).join(""))];
        }
        return [];
      });
    }

    const emptyDiff = (landedNothing: number): Plan =>
      planFor(changedNothing, snapshotOf(anIssue({ number: 7, labels: ["ready-for-agent"], landedNothing })), kitConfig());

    it.each<[string, Plan[]]>([
      ["a Design flaw", [planFor(reviewed("verdict: design-flaw\n\nWrong approach."), snapshotOfPullRequest(aPullRequest()), kitConfig())]],
      [
        "Retries used up",
        [
          planFor(
            reviewed("verdict: execution-flaw\n\nStill throws."),
            snapshotOfPullRequest(aPullRequest({ pushedSinceVerdict: true, verdicts: [earlier("reviewer"), earlier("ci")] })),
            kitConfig(),
          ),
        ],
      ],
      [
        "the Operator's needs-design at the Merge gate",
        [
          planFor(
            { kind: "pull-request-labeled", pullRequest: 50, label: "needs-design" },
            snapshotOfPullRequest(aPullRequest({ draft: false })),
            kitConfig(),
          ),
        ],
      ],
      ["a third empty diff", [emptyDiff(0), emptyDiff(1), emptyDiff(2)]],
    ])("reads a Ticket sent back by %s as a re-design, which starts before an older new issue", async (_, plans) => {
      const queue = await gathered([
        issue(4, { timelineItems: { nodes: [labelled("needs-design", "2026-10-01T09:00:00Z")] } }),
        issue(7, { comments: { nodes: [person("Can we add a cart total?"), ...plans.flatMap(ticketCommentsOf)] } }),
      ]);

      expect(queue.issues.map(({ number, redesign }) => ({ number, redesign }))).toEqual([
        { number: 4, redesign: false },
        { number: 7, redesign: true },
      ]);
      expect(planFor({ kind: "design-queue-check" }, designQueueSnapshotOf(queue.issues, { designTurnsInProgress: queue.designTurnsInProgress }), kitConfig({ caps: { ...DEFAULT_KIT_CONFIG.caps, designSessions: 1 } }))).toEqual({
        kind: "act",
        actions: [{ kind: "add-labels", issue: 7, labels: ["agent:design"] }],
      });
    });

    it("doesn't read an issue with neither, two empty diffs, or a person quoting the note, as a re-design", async () => {
      const note = "<!-- fabrik:back-to-design 50 operator -->\n**Back to design.**";
      const queue = await gathered([
        issue(6, { comments: { nodes: [person("Can we add a cart total?")] } }),
        issue(7, { comments: { nodes: [emptyDiff(0), emptyDiff(1)].flatMap(ticketCommentsOf) } }),
        issue(8, { comments: { nodes: [person(note)] } }),
      ]);

      expect(queue.issues.map(({ redesign }) => redesign)).toEqual([false, false, false]);
    });
  });

  it("falls back to when the issue was opened when its timeline shows no needs-design", async () => {
    const queue = await gathered([issue(3, { timelineItems: { nodes: [] } })]);

    expect(queue.issues[0]?.neededDesignAt).toBe("2026-10-01T09:00:00Z");
  });

  describe("without a token that can read workflow runs, as on the scheduled tick", () => {
    it("reads a first turn in progress from the Kit taking agent:design off since the issue last got needs-design", async () => {
      const queue = await gathered(
        [
          issue(3, {
            timelineItems: {
              nodes: [labelled("needs-design", "2026-11-01T09:00:00Z"), unlabelled("agent:design", "2026-11-01T10:00:00Z")],
            },
          }),
          issue(4, {
            timelineItems: {
              nodes: [unlabelled("agent:design", "2026-10-01T10:00:00Z"), labelled("needs-design", "2026-11-01T09:00:00Z")],
            },
          }),
          issue(5, {
            timelineItems: {
              nodes: [labelled("needs-design", "2026-11-01T09:00:00Z"), unlabelled("agent:design", "2026-11-01T10:00:00Z", "User")],
            },
          }),
          issue(6),
        ],
        null,
      );

      expect(queue.designTurnsInProgress).toEqual([3]);
      expect(holding(queue)).toEqual({ 3: true, 4: false, 5: false, 6: false });
    });

    it("doesn't take needs-design coming off for it being added", async () => {
      const queue = await gathered(
        [
          issue(3, {
            timelineItems: {
              nodes: [labelled("needs-design", "2026-11-01T09:00:00Z"), unlabelled("needs-design", "2026-11-02T09:00:00Z")],
            },
          }),
        ],
        null,
      );

      expect(queue.issues[0]?.neededDesignAt).toBe("2026-11-01T09:00:00Z");
    });
  });
});

describe("Gathering an issue's blocked-by edges", () => {
  it("holds only the open issues in this repo blocking it, and the open issues in this repo it blocks", async () => {
    const github = {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("issue(number: $number)")) {
          return {
            repository: {
              owner: { login: "acme" },
              issue: {
                number: 6,
                state: "OPEN",
                author: { login: "someone" },
                labels: { nodes: [{ name: "needs-design" }] },
                parent: null,
                comments: { nodes: [] },
                timelineItems: { nodes: [] },
                closedByPullRequestsReferences: { nodes: [] },
                blockedBy: {
                  nodes: [
                    { number: 10, state: "OPEN", repository: { nameWithOwner: "acme/shop" } },
                    { number: 9, state: "CLOSED", repository: { nameWithOwner: "acme/shop" } },
                    { number: 11, state: "OPEN", repository: { nameWithOwner: "acme/api" } },
                  ],
                },
                blocking: {
                  nodes: [
                    { number: 7, state: "OPEN", repository: { nameWithOwner: "acme/shop" } },
                    { number: 8, state: "CLOSED", repository: { nameWithOwner: "acme/shop" } },
                    { number: 12, state: "OPEN", repository: { nameWithOwner: "acme/api" } },
                  ],
                },
              },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "label-added", issue: 6, label: "needs-design" }, null, null);

    expect(snapshot.issue).toMatchObject({ openBlockers: [10], openBlocking: [7] });
  });
});

describe("Gathering a closed Ticket's agent draft PRs", () => {
  it("holds only the open draft PRs the Fabrik App opened from this Ticket's own agent branch, which closing it closes (#428)", async () => {
    const pull = (number: number, isDraft: boolean, headRefName: string, author: string) => ({ number, state: "OPEN", isDraft, headRefName, author: { __typename: author } });
    const github = {
      async graphql(query: string): Promise<unknown> {
        if (!query.includes("issue(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
        const data = issueData(9);
        return {
          repository: {
            ...data.repository,
            issue: {
              ...data.repository.issue,
              state: "CLOSED",
              labels: { nodes: [{ name: "ready-for-agent" }] },
              closedByPullRequestsReferences: {
                nodes: [
                  pull(53, true, "fabrik/ticket-8", "Bot"),
                  pull(50, true, "fabrik/ticket-9", "Bot"),
                  pull(51, false, "fabrik/ticket-9", "Bot"),
                  pull(52, true, "someone/fix-9", "User"),
                ],
              },
            },
          },
        };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "issue-closed", issue: 9 }, null, null);

    expect(snapshot.issue).toMatchObject({ openPullRequests: [50, 51, 52, 53], openAgentDrafts: [50] });
  });
});

describe("Gathering a Ticket's open PRs (#543)", () => {
  it("leaves out a closing PR that has merged, which GitHub still lists, so agent:implement loads no PR to resume", async () => {
    const github = {
      async graphql(query: string): Promise<unknown> {
        if (!query.includes("issue(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
        const data = issueData(130);
        return {
          repository: {
            ...data.repository,
            issue: {
              ...data.repository.issue,
              labels: { nodes: [{ name: "ready-for-agent" }] },
              closedByPullRequestsReferences: {
                nodes: [
                  { number: 131, state: "MERGED", isDraft: false, headRefName: "fabrik/ticket-130", author: { __typename: "Bot" } },
                ],
              },
            },
          },
        };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "label-added", issue: 130, label: "agent:implement" }, null, null);

    expect(snapshot.issue).toMatchObject({ openPullRequests: [], mergedPullRequests: [131], openAgentDrafts: [] });
    expect(snapshot.pullRequest).toBeNull();
  });

  it("asks GitHub for each closing PR's state", async () => {
    const queries: string[] = [];
    const github = {
      async graphql(query: string): Promise<unknown> {
        queries.push(query);
        return query.includes("issue(number: $number)") ? issueData(9) : { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;

    await gatherSnapshot(github, repo, { kind: "issue-closed", issue: 9 }, null, null);

    const issueQuery = queries.find((query) => query.includes("issue(number: $number)")) ?? "";
    expect(/closedByPullRequestsReferences\([^)]*\) \{ nodes \{[^}]*\bstate\b/.test(issueQuery)).toBe(true);
  });
});

describe("Gathering a Ticket's Kept branch (#536)", () => {
  const KEPT = "f".repeat(40);
  /** A fake GitHub whose Ticket #9 carries these labels, and whose fabrik/ticket-9 is `ref` (null when gone); it counts the Kept-branch reads. */
  function githubWith(labels: string[], ref: unknown) {
    const reads: Record<string, unknown>[] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("qualifiedName")) {
          reads.push(variables);
          return { repository: { ref } };
        }
        if (!query.includes("issue(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
        const data = issueData(9);
        return { repository: { ...data.repository, issue: { ...data.repository.issue, labels: { nodes: labels.map((name) => ({ name })) } } } };
      },
    } as unknown as GitHub;
    return { github, reads };
  }
  const event = { kind: "label-added", issue: 9, label: "agent:implement" } as const;

  it("reads a marked Ticket's Kept branch, with the latest PR from it closed unmerged", async () => {
    const ref = {
      target: { oid: KEPT },
      associatedPullRequests: { nodes: [{ number: 240, merged: true }, { number: 230, merged: false }, { number: 200, merged: false }] },
    };
    const { github, reads } = githubWith(["ready-for-agent", "fabrik:kept-branch"], ref);

    const snapshot = await gatherSnapshot(github, repo, event, null, null);

    expect(snapshot.issue?.keptBranch).toEqual({ head: KEPT, pullRequest: 230 });
    expect(reads).toEqual([{ owner: "acme", name: "shop", ref: "refs/heads/fabrik/ticket-9" }]);
  });

  it("reads a marked Ticket's gone Kept branch as null", async () => {
    const { github } = githubWith(["ready-for-agent", "fabrik:kept-branch"], null);

    expect((await gatherSnapshot(github, repo, event, null, null)).issue?.keptBranch).toBeNull();
  });

  it("doesn't read an unmarked Ticket's branch at all", async () => {
    const { github, reads } = githubWith(["ready-for-agent"], { target: { oid: KEPT }, associatedPullRequests: { nodes: [] } });

    expect((await gatherSnapshot(github, repo, event, null, null)).issue?.keptBranch).toBeNull();
    expect(reads).toEqual([]);
  });
});

/** An issue's parent, as GitHub holds it. */
interface GitHubParent {
  number: number;
  state: "OPEN" | "CLOSED";
  labels: string[];
}

/** The issue a Loop event is about, as GitHub holds it: opened by `author`, with this title, body, these labels and this parent. */
function issueGitHub({
  author = { login: "someone", __typename: "User" },
  title = "An issue",
  body = "",
  labels = ["needs-design"],
  parent = null,
}: {
  author?: { login: string; __typename: string } | null;
  title?: string;
  body?: string;
  labels?: string[];
  parent?: GitHubParent | null;
} = {}): GitHub {
  return {
    async graphql(query: string): Promise<unknown> {
      if (!query.includes("issue(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      // GitHub answers only the fields the query selects.
      const issueQuery = query.slice(query.indexOf("issue(number: $number)"));
      const selectsType = /^\s*author \{[^}]*__typename/m.test(issueQuery);
      const parentSelection = /^\s*parent \{[^}]*/m.exec(issueQuery)?.[0] ?? "";
      return {
        repository: {
          owner: { login: "acme" },
          issue: {
            number: 98,
            state: "OPEN",
            author: author === null || selectsType ? author : { login: author.login },
            ...(/^\s*title$/m.test(issueQuery) ? { title } : {}),
            ...(/^\s*body$/m.test(issueQuery) ? { body } : {}),
            labels: { nodes: labels.map((name) => ({ name })) },
            parent:
              parent === null
                ? null
                : {
                    number: parent.number,
                    ...(/\bstate\b/.test(parentSelection) ? { state: parent.state } : {}),
                    ...(/\blabels\(/.test(parentSelection) ? { labels: { nodes: parent.labels.map((name) => ({ name })) } } : {}),
                  },
            comments: { nodes: [] },
            timelineItems: { nodes: [] },
            closedByPullRequestsReferences: { nodes: [] },
            blockedBy: { nodes: [] },
            blocking: { nodes: [] },
          },
        },
      };
    },
  } as unknown as GitHub;
}

/** The Fabrik App's bot login, its slug with `[bot]`, as a run that knows it has it. */
const APP_LOGIN = "fabrik-app[bot]";

/** The Fabrik App's bot, as GraphQL names it: without its [bot] suffix. */
const APP_BOT = { login: "fabrik-app", __typename: "Bot" };

/** An open needs-design issue with nothing else on it, as the issue query answers for it. */
const issueData = (number: number) => ({
  repository: {
    owner: { login: "acme" },
    issue: {
      number,
      state: "OPEN",
      author: { login: "someone" },
      labels: { nodes: [{ name: "needs-design" }] },
      parent: null,
      comments: { nodes: [] },
      timelineItems: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
      blockedBy: { nodes: [] },
      blocking: { nodes: [] },
    },
  },
});

/** A Design-session turn's map outcome, with one research Decision. */
const aMap = {
  kind: "map",
  comment: "Too foggy for one session.",
  destination: "Patients book group classes online.",
  notes: "",
  notYetSpecified: "",
  outOfScope: "",
  decisions: [{ key: "provider", title: "Which provider?", body: "Which one?", type: "research", blockedBy: [] }],
};

describe("Gathering an issue's body", () => {
  it("holds the body as it stands, so a Design session's rewrite can keep its Monitor marker and carry its marker lines forward", async () => {
    const body = "<!-- fabrik:monitor sentry:4504 -->\n## Production error\n\nFrom audit #40\n<!-- fabrik:escape strong #31 -->";
    const event = { kind: "label-added", issue: 98, label: "needs-design" } as const;

    const snapshot = await gatherSnapshot(issueGitHub({ author: APP_BOT, body }), repo, event, null, APP_LOGIN);

    expect(snapshot.issue?.body).toBe(body);
  });
});

describe("Gathering an issue's title", () => {
  it("holds the title as it stands, so a resolved research Decision's line in its Map names it", async () => {
    const event = { kind: "issue-opened", issue: 98 } as const;

    const snapshot = await gatherSnapshot(issueGitHub({ title: "Which payment provider fits group classes?" }), repo, event, null, APP_LOGIN);

    expect(snapshot.issue?.title).toBe("Which payment provider fits group classes?");
  });
});

describe("Gathering an issue's parent", () => {
  const labelled = { kind: "label-added", issue: 98, label: "agent:research" } as const;

  it("holds the parent's number, whether it's open and its labels, so the core can tell a research Decision's Map is open", async () => {
    const github = issueGitHub({
      labels: ["wayfinder:research", "agent:research"],
      parent: { number: 3, state: "OPEN", labels: ["enhancement", "wayfinder:map"] },
    });

    const snapshot = await gatherSnapshot(github, repo, labelled, null, APP_LOGIN);

    expect(snapshot.issue).toMatchObject({ parent: 3, parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] } });
  });

  it("holds a closed parent as closed", async () => {
    const github = issueGitHub({ labels: ["wayfinder:research"], parent: { number: 3, state: "CLOSED", labels: ["wayfinder:map"] } });

    const snapshot = await gatherSnapshot(github, repo, labelled, null, APP_LOGIN);

    expect(snapshot.issue?.parentIssue).toEqual({ number: 3, open: false, labels: ["wayfinder:map"] });
  });

  it("holds no parent for an issue that isn't a sub-issue", async () => {
    const snapshot = await gatherSnapshot(issueGitHub({ labels: ["wayfinder:research"] }), repo, labelled, null, APP_LOGIN);

    expect(snapshot.issue).toMatchObject({ parent: null, parentIssue: null });
  });
});

describe("Gathering who opened an issue", () => {
  const opened = { kind: "issue-opened", issue: 98 } as const;

  /** The issue as gathered, opened by this account, by a run that knows the App's login, or that doesn't (null). */
  async function openedBy(author: { login: string; __typename: string } | null, appLogin: string | null = APP_LOGIN) {
    return (await gatherSnapshot(issueGitHub({ author, labels: ["fabrik:audit"] }), repo, opened, null, appLogin)).issue;
  }

  it("says the Fabrik App opened it when its bot did, so its Audit markers are read and a Design session keeps its Monitor marker", async () => {
    expect(await openedBy(APP_BOT)).toMatchObject({ author: "fabrik-app", byApp: true });
  });

  it("says the App didn't when a person did, whatever their login", async () => {
    expect(await openedBy({ login: "fabrik-app", __typename: "User" })).toMatchObject({ author: "fabrik-app", byApp: false });
  });

  it.each([
    ["another bot", { login: "other-app", __typename: "Bot" }],
    ["a deleted account", null],
  ])("says the App didn't when %s did, so its issue is never read for Audit markers", async (_, author) => {
    expect(await openedBy(author)).toMatchObject({ byApp: false });
  });

  it("keeps no Monitor marker in the Spec a Design session writes from an issue another bot opened", async () => {
    const finished = {
      kind: "agent-run-finished",
      role: "design",
      issue: 98,
      output: JSON.stringify({
        kind: "spec",
        comment: "Too big for one PR.",
        spec: { title: "Spec: Booking form errors", body: "## Problem Statement\n\nThe booking form throws." },
        tickets: [{ key: "fix", title: "Fix the form", body: "## What to build\n\nThe fix.", blockedBy: [] }],
      }),
    } as const;
    const github = issueGitHub({
      author: { login: "dependabot", __typename: "Bot" },
      body: "<!-- fabrik:monitor sentry:4504 -->\n## Production error",
      labels: ["fabrik:monitor", "needs-design"],
    });

    const plan = planFor(finished, await gatherSnapshot(github, repo, finished, null, APP_LOGIN), kitConfig());

    const spec = plan.kind === "act" ? plan.actions.find((action) => action.kind === "create-issue" && action.key === "spec") : undefined;
    expect(spec?.kind).toBe("create-issue");
    expect(spec?.kind === "create-issue" ? spec.body : "").not.toContain("fabrik:monitor");
    expect(spec?.kind === "create-issue" ? spec.labels : []).not.toContain("fabrik:monitor");
  });

  // The Kit job routes the App's pending Audit to its Auditor run, which it couldn't if no issue were the App's.
  it("takes any bot, but never a person, for the Fabrik App when the run doesn't know the App's login, as the Kit job, which only routes, doesn't", async () => {
    expect(await openedBy(APP_BOT, null)).toMatchObject({ byApp: true });
    expect(await openedBy({ login: "fabrik-app", __typename: "User" }, null)).toMatchObject({ byApp: false });
  });

  // The Kit job routes the event with no Fabrik App token, so it gathers with no App login.
  it("lets the Kit job, which doesn't know the App's login, route the App's pending Audit to its Auditor run", async () => {
    const github = issueGitHub({ author: APP_BOT, body: auditBody(AUDITED_SHA, "pending"), labels: ["fabrik:audit"] });

    const plan = planFor(opened, await gatherSnapshot(github, repo, opened, null, null), kitConfig());

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "audit", issue: 98, commit: AUDITED_SHA }] });
  });

  it("lets the Kit job, which doesn't know the App's login, route the App's pending Retro to its Retro run", async () => {
    const github = issueGitHub({ author: APP_BOT, body: retroBody(RETRO_WINDOW_END, "pending"), labels: ["fabrik:retro"] });

    const plan = planFor(opened, await gatherSnapshot(github, repo, opened, null, null), kitConfig());

    expect(plan).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "retro", issue: 98 }] });
  });

  // The Kit job can't tell the App's bot from another, and telling it would take a setup step (#150 rules one out).
  it("takes another bot's pending Audit for the App's only where the login isn't known: the Kit job starts its Auditor run, whose result the push job drops", async () => {
    const github = issueGitHub({ author: { login: "other-app", __typename: "Bot" }, body: auditBody(AUDITED_SHA, "pending"), labels: ["fabrik:audit"] });
    const finished = {
      kind: "audit-run-finished",
      issue: 98,
      output: JSON.stringify({ candidates: [], topRecommendation: null }),
      window: { kind: "last-days", days: 30 },
      runUrl: "https://github.com/acme/shop/actions/runs/1",
      repoUrl: "https://github.com/acme/shop",
    } as const;

    const kitJob = await gatherSnapshot(github, repo, opened, null, null);
    const pushJob = await gatherSnapshot(github, repo, finished, null, APP_LOGIN);

    expect([kitJob.issue?.byApp, pushJob.issue?.byApp]).toEqual([true, false]);
    expect(planFor(opened, kitJob, kitConfig())).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "audit", issue: 98 }] });
    expect(planFor(finished, pushJob, kitConfig())).toEqual({
      kind: "nothing",
      reason: "#98 is no longer a pending Audit, so its Auditor's result is stale",
    });
  });

  it("takes another bot's pending Retro for the App's only where the login isn't known: the Kit job starts its Retro run, whose result the push job drops", async () => {
    const github = issueGitHub({ author: { login: "other-app", __typename: "Bot" }, body: retroBody(RETRO_WINDOW_END, "pending"), labels: ["fabrik:retro"] });
    const finished = {
      kind: "retro-run-finished",
      issue: 98,
      output: JSON.stringify({ proposals: [] }),
      evidence: { window: { start: "2026-10-24T06:00:00.000Z", end: RETRO_WINDOW_END }, refs: [], streakTable: [], transcripts: {} },
      runUrl: "https://github.com/acme/shop/actions/runs/1",
      repoUrl: "https://github.com/acme/shop",
    } as const;

    const kitJob = await gatherSnapshot(github, repo, opened, null, null);
    const pushJob = await gatherSnapshot(github, repo, finished, null, APP_LOGIN);

    expect([kitJob.issue?.byApp, pushJob.issue?.byApp]).toEqual([true, false]);
    expect(planFor(opened, kitJob, kitConfig())).toMatchObject({ kind: "act", actions: [{ kind: "start-agent-run", role: "retro", issue: 98 }] });
    expect(planFor(finished, pushJob, kitConfig())).toEqual({
      kind: "nothing",
      reason: "#98 is no longer a pending Retro, so its Retro run's result is stale",
    });
  });
});

/** An issue a PR's body closes, as GitHub links it: its number and labels. */
interface ClosingIssue {
  readonly number: number;
  readonly labels: readonly string[];
  /** Its comments, oldest first: each body, and who wrote it. */
  readonly comments?: readonly { readonly body: string; readonly author: { readonly login: string; readonly __typename: string } }[];
  /** Its state, open unless a test says otherwise. */
  readonly state?: "OPEN" | "CLOSED";
}

/** The pull request a Loop event is about, as GitHub holds it: opened by `author`, with this body, closing these issues. */
function pullRequestGitHub({
  author = APP_BOT,
  body = "",
  closing = [],
}: { author?: { login: string; __typename: string } | null; body?: string; closing?: readonly ClosingIssue[] } = {}): GitHub {
  return {
    async graphql(query: string): Promise<unknown> {
      if (!query.includes("pullRequest(number: $number)")) return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      // GitHub answers only the fields the query selects.
      const pullRequestQuery = query.slice(query.indexOf("pullRequest(number: $number)"));
      const selectsLogin = /^\s*author \{[^}]*login/m.test(pullRequestQuery);
      return {
        repository: {
          owner: { login: "acme" },
          pullRequest: {
            number: 50,
            state: "OPEN",
            isDraft: true,
            headRefName: "fabrik/ticket-7",
            headRefOid: HEAD_SHA,
            author: author === null || selectsLogin ? author : { __typename: author.__typename },
            ...(/^\s*body$/m.test(pullRequestQuery) ? { body } : {}),
            url: "https://github.com/acme/shop/pull/50",
            labels: { nodes: [] },
            comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            changesRequests: { nodes: [] },
            draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            createdAt: "2026-11-01T09:00:00Z",
            forcePushes: { nodes: [] },
            commits: { pageInfo: { hasPreviousPage: false }, nodes: [] },
            ...(/closingIssuesReferences/.test(pullRequestQuery)
              ? {
                  closingIssuesReferences: {
                    nodes: closing.map((issue) => ({
                      number: issue.number,
                      state: issue.state ?? "OPEN",
                      labels: { nodes: issue.labels.map((name) => ({ name })) },
                      ...(/closingIssuesReferences[^]*comments\(/.test(pullRequestQuery)
                        ? {
                            comments: {
                              nodes: (issue.comments ?? []).map(({ body, author }) => ({
                                body,
                                ...(/closingIssuesReferences[^]*comments\([^]*author/.test(pullRequestQuery)
                                  ? { author }
                                  : {}),
                              })),
                            },
                          }
                        : {}),
                    })),
                  },
                }
              : {}),
          },
        },
      };
    },
  } as unknown as GitHub;
}

describe("Gathering the labels of the Ticket a pull request was cut for", () => {
  const pushed = { kind: "pull-request-pushed", pullRequest: 50 } as const;
  const gathered = async (closing: readonly ClosingIssue[]) =>
    (await gatherSnapshot(pullRequestGitHub({ body: "Adds a waitlist.\n\nCloses #7", closing }), repo, pushed, null, APP_LOGIN)).pullRequest;

  it("reads the labels of the Ticket its agent branch names, from the issues it closes", async () => {
    const pullRequest = await gathered([
      { number: 3, labels: ["bug"] },
      { number: 7, labels: ["enhancement", "ready-for-agent", "fabrik:step-up"] },
    ]);

    expect(pullRequest).toMatchObject({ ticket: 7, ticketLabels: ["enhancement", "ready-for-agent", "fabrik:step-up"] });
  });

  it("reads no Ticket labels when the PR closes no issue its branch names", async () => {
    expect(await gathered([{ number: 3, labels: ["fabrik:step-up"] }])).toMatchObject({ ticket: 7, ticketLabels: [] });
    expect(await gathered([])).toMatchObject({ ticket: 7, ticketLabels: [] });
  });

  it("reads whether that Ticket is open, so closing the PR by hand never stops a closed one (#428)", async () => {
    expect(await gathered([{ number: 7, labels: ["ready-for-agent"] }])).toMatchObject({ ticketOpen: true });
    expect(await gathered([{ number: 7, labels: ["ready-for-agent"], state: "CLOSED" }])).toMatchObject({ ticketOpen: false });
    expect(await gathered([{ number: 3, labels: [] }])).toMatchObject({ ticketOpen: false });
  });
});

describe("Gathering the empty diffs of the Ticket a pull request was cut for (#415)", () => {
  const pushed = { kind: "pull-request-pushed", pullRequest: 50 } as const;
  const gathered = async (closing: readonly ClosingIssue[]) =>
    (await gatherSnapshot(pullRequestGitHub({ body: "Adds a waitlist.\n\nCloses #7", closing }), repo, pushed, null, APP_LOGIN)).pullRequest;
  const emptyDiff = { body: `${EMPTY_DIFF_MARKER}\nThe Implementer's branch for #7 changed nothing.`, author: APP_BOT };

  it("counts the Ticket's empty diffs from its comments, as the Ticket's own snapshot does", async () => {
    const pullRequest = await gathered([
      { number: 3, labels: [], comments: [emptyDiff] },
      { number: 7, labels: ["ready-for-agent"], comments: [{ body: "Looks good.", author: { login: "operator", __typename: "User" } }, emptyDiff, emptyDiff] },
    ]);

    expect(pullRequest).toMatchObject({ ticket: 7, ticketLandedNothing: 2 });
  });

  it("counts only the Fabrik App's empty-diff markers, so nobody, another bot included, can spend the Ticket's Retries (#426)", async () => {
    const forged = [
      { ...emptyDiff, author: { login: "operator", __typename: "User" } },
      { ...emptyDiff, author: { login: "dependabot", __typename: "Bot" } },
    ];
    const pullRequest = await gathered([{ number: 7, labels: ["ready-for-agent"], comments: [emptyDiff, ...forged] }]);

    expect(pullRequest).toMatchObject({ ticket: 7, ticketLandedNothing: 1 });
  });

  it("counts none when the PR closes no issue its branch names", async () => {
    expect(await gathered([{ number: 3, labels: [], comments: [emptyDiff] }])).toMatchObject({ ticket: 7, ticketLandedNothing: 0 });
  });
});

describe("Gathering whether an Operator's review holds inline comments (#435)", () => {
  /** The PR's GitHub, where review 900 holds `inline` inline comments. */
  function githubWithReview(inline: number) {
    const reads: string[] = [];
    const github = {
      ...pullRequestGitHub(),
      async rest(method: string, path: string): Promise<unknown> {
        reads.push(`${method} ${path}`);
        // The read asks for one a page (`reads` checks it does), so that is all a page holds.
        return Array.from({ length: Math.min(inline, 1) }, (_, i) => ({ id: 8000 + i }));
      },
    } as unknown as GitHub;
    return { github, reads };
  }
  const reviewed = (body: boolean) =>
    ({
      kind: "pull-request-commented",
      pullRequest: 50,
      commenter: "operator",
      commenterIsBot: false,
      on: { kind: "review", review: 900, node: "PRR_kwDO900", hasBody: body },
    }) as const;

  it("reads one inline comment of the review, enough to say it holds some", async () => {
    const { github, reads } = githubWithReview(3);

    const snapshot = await gatherSnapshot(github, repo, reviewed(false), null, APP_LOGIN);

    expect(snapshot.reviewHasInlineComments).toBe(true);
    expect(reads).toEqual(["GET /repos/acme/shop/pulls/50/reviews/900/comments?per_page=1"]);
  });

  it("finds none in a bare Approve", async () => {
    const { github } = githubWithReview(0);

    expect((await gatherSnapshot(github, repo, reviewed(false), null, APP_LOGIN)).reviewHasInlineComments).toBe(false);
  });

  it("reads nothing for a review with a body, a conversation comment or any other event", async () => {
    const { github, reads } = githubWithReview(3);
    const conversation = { ...reviewed(true), on: { kind: "conversation", comment: 7001 } } as const;

    expect((await gatherSnapshot(github, repo, reviewed(true), null, APP_LOGIN)).reviewHasInlineComments).toBeNull();
    expect((await gatherSnapshot(github, repo, conversation, null, APP_LOGIN)).reviewHasInlineComments).toBeNull();
    expect((await gatherSnapshot(github, repo, { kind: "pull-request-pushed", pullRequest: 50 }, null, APP_LOGIN)).reviewHasInlineComments).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("Gathering a pull request's UI evidence marker", () => {
  const pushed = { kind: "pull-request-pushed", pullRequest: 50 } as const;
  const captured: CaptureResult = {
    outcome: "captured",
    headSha: HEAD_SHA,
    captures: [{ route: "/book", reason: "ticket", viewport: "mobile", side: "after", status: 200, image: "after-mobile-book.png" }],
  };
  /** A UI PR's body as the push job writes it: the summary, the evidence section and its marker, then Closes. */
  const uiBody = (run: number, artifact: number | null) =>
    [
      "Adds a waitlist to full days.",
      evidenceSection({ result: captured, run, artifact, gallery: "https://github.com/acme/shop/actions/runs/9100/artifacts/9201", preview: { kind: "none" } }),
      "Closes #7",
    ].join("\n\n");

  /** The pull request as gathered, opened by this account, by a run that knows the App's login, or that doesn't (null). */
  async function gathered(body: string, author: { login: string; __typename: string } | null = APP_BOT, appLogin: string | null = APP_LOGIN) {
    return (await gatherSnapshot(pullRequestGitHub({ author, body }), repo, pushed, null, appLogin)).pullRequest;
  }

  it("reads back where the evidence section's marker says the UI evidence is kept, in a body the Fabrik App wrote", async () => {
    expect(await gathered(uiBody(9100, 9202))).toMatchObject({ uiEvidenceMarker: { run: 9100, artifact: 9202 } });
  });

  it("reads back a marker naming no artifact, as when capture left no result", async () => {
    expect(await gathered(uiBody(9100, null))).toMatchObject({ uiEvidenceMarker: { run: 9100, artifact: null } });
  });

  it("reads back the capture's outcome the marker records: null for a capture that captured, else why it failed", async () => {
    const failed: CaptureResult = { outcome: "failed", reason: "build-failed", headSha: HEAD_SHA, captures: [] };
    const failedBody = evidenceSection({ result: failed, run: 9100, artifact: null, gallery: null, preview: { kind: "none" } });

    expect((await gathered(uiBody(9100, 9202)))?.uiEvidenceMarker).toEqual({ run: 9100, artifact: 9202, failure: null });
    expect((await gathered(`Adds a waitlist.\n\n${failedBody}\n\nCloses #7`))?.uiEvidenceMarker).toEqual({
      run: 9100,
      artifact: null,
      failure: "build-failed",
    });
  });

  it.each([
    ["from before markers recorded it", `<!-- fabrik:ui-evidence {"run":9100,"artifact":null} -->`],
    ["that names no capture failure the Kit knows", `<!-- fabrik:ui-evidence {"run":9100,"artifact":null,"failure":"on-fire"} -->`],
  ])("reads a marker %s as recording no capture outcome, and still marks the PR UI", async (_, marker) => {
    expect((await gathered(`Adds a waitlist.\n\n${marker}\n\nCloses #7`))?.uiEvidenceMarker).toEqual({ run: 9100, artifact: null });
  });

  it("finds no UI evidence on a PR whose body has no marker: not a UI PR", async () => {
    expect(await gathered("Adds a retry to the booking API.\n\nCloses #7")).toMatchObject({ uiEvidenceMarker: null });
  });

  it.each([
    ["a person", { login: "fabrik-app", __typename: "User" }],
    ["another bot", { login: "other-app", __typename: "Bot" }],
    ["a deleted account", null],
  ])("ignores a marker in the body of a PR %s opened, so nobody can fake one", async (_, author) => {
    expect(await gathered(uiBody(9100, 9202), author)).toMatchObject({ uiEvidenceMarker: null });
  });

  it("takes any bot's body for the App's when the run doesn't know the App's login, as the Kit job, which only routes, doesn't", async () => {
    expect(await gathered(uiBody(9100, 9202), APP_BOT, null)).toMatchObject({ uiEvidenceMarker: { run: 9100, artifact: 9202 } });
    expect(await gathered(uiBody(9100, 9202), { login: "fabrik-app", __typename: "User" }, null)).toMatchObject({ uiEvidenceMarker: null });
  });

  it.each([
    ["isn't JSON", "<!-- fabrik:ui-evidence {run:9100} -->"],
    ["names no run", `<!-- fabrik:ui-evidence {"artifact":9202} -->`],
    ["names a run that isn't an id", `<!-- fabrik:ui-evidence {"run":"9100","artifact":9202} -->`],
    ["names an artifact that isn't an id", `<!-- fabrik:ui-evidence {"run":9100,"artifact":-1} -->`],
    ["shares its line", `See <!-- fabrik:ui-evidence {"run":9100,"artifact":9202} -->`],
  ])("finds no UI evidence where the marker %s", async (_, marker) => {
    expect(await gathered(`Adds a waitlist.\n\n${marker}\n\nCloses #7`)).toMatchObject({ uiEvidenceMarker: null });
  });
});

describe("Gathering the existing tests a pull request's Implement runs changed (#463)", () => {
  const pushed = { kind: "pull-request-pushed", pullRequest: 50 } as const;
  /** An agent PR's body as the push job writes it: the summary, the Changed existing tests section, then Closes. */
  const body = (paths: readonly string[]) => ["Adds a waitlist to full days.", changedTestsSection(paths), "Closes #7"].join("\n\n");

  async function gathered(text: string, author: { login: string; __typename: string } | null = APP_BOT) {
    return (await gatherSnapshot(pullRequestGitHub({ author, body: text }), repo, pushed, null, APP_LOGIN)).pullRequest;
  }

  it("reads back the list the section's marker records, in a body the Fabrik App wrote, a path with <!-- --> in it among them", async () => {
    expect(await gathered(body(["src/cart.test.ts", "test/a-->b.ts"]))).toMatchObject({ changedTests: ["src/cart.test.ts", "test/a-->b.ts"] });
  });

  it("finds none on a PR whose body has no marker, or one that doesn't read", async () => {
    expect(await gathered("Adds a retry to the booking API.\n\nCloses #7")).toMatchObject({ changedTests: [] });
    expect(await gathered("Adds a retry.\n\n<!-- fabrik:changed-tests [1] -->\n\nCloses #7")).toMatchObject({ changedTests: [] });
  });

  it("ignores a marker in the body of a PR a person opened, so nobody can plant a list", async () => {
    expect(await gathered(body(["src/cart.test.ts"]), { login: "fabrik-app", __typename: "User" })).toMatchObject({ changedTests: [] });
  });
});

describe("Gathering an issue's Design session", () => {
  async function gatheredIssue(
    comments: { body: string; createdAt?: string; author: { login?: string; __typename: string }; fullDatabaseId?: string }[],
    timeline: unknown[] = [],
    appLogin: string | null = null,
  ) {
    const github = {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("issue(number: $number)")) {
          return {
            repository: {
              owner: { login: "acme" },
              issue: {
                number: 6,
                state: "OPEN",
                author: { login: "someone" },
                labels: { nodes: [{ name: "needs-design" }] },
                parent: null,
                // GitHub reads a comment's id as a BigInt, which comes back as a string.
                comments: { nodes: comments.map((comment, i) => ({ createdAt: "2026-11-02T09:00:00Z", fullDatabaseId: String(5000 + i), ...comment })) },
                timelineItems: { nodes: timeline },
                closedByPullRequestsReferences: { nodes: [] },
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    const event = { kind: "issue-comment-created", issue: 6, commenter: "operator", commenterIsBot: false, body: "More context", comment: 9 } as const;
    return (await gatherSnapshot(github, repo, event, null, appLogin)).issue;
  }

  it("reads a Design-session turn's failure notice as a failed turn, so the session keeps its slot", async () => {
    const issue = await gatheredIssue([
      { body: `${DESIGN_TURN_FAILED_MARKER}\n@operator The Design-session turn run on #6 failed.`, author: { __typename: "Bot" } },
    ]);

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: true });
  });

  it("reads an issue with no round and no failure as holding no slot", async () => {
    const issue = await gatheredIssue([{ body: "Some context while it waits", author: { __typename: "User" } }]);

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: false });
  });

  it("reads the Kit taking agent:design off since the issue last got needs-design as its first turn having started", async () => {
    const labelled = { __typename: "LabeledEvent", createdAt: "2026-11-01T09:00:00Z", label: { name: "needs-design" } };
    const claimed = {
      __typename: "UnlabeledEvent",
      createdAt: "2026-11-01T10:00:00Z",
      label: { name: "agent:design" },
      actor: { __typename: "Bot" },
    };

    expect(await gatheredIssue([], [labelled, claimed])).toMatchObject({ firstTurnClaimed: true });
    expect(await gatheredIssue([], [claimed, { ...labelled, createdAt: "2026-11-02T09:00:00Z" }])).toMatchObject({ firstTurnClaimed: false });
  });

  it("counts only the rounds and failure notices posted since the issue last got needs-design", async () => {
    const issue = await gatheredIssue(
      [
        { body: "<!-- fabrik:design-round 1 -->\n@operator **Design session, round 1.**", createdAt: "2026-10-02T09:00:00Z", author: { __typename: "Bot" } },
        { body: `${DESIGN_TURN_FAILED_MARKER}\n@operator The Design-session turn run on #6 failed.`, createdAt: "2026-10-03T09:00:00Z", author: { __typename: "Bot" } },
      ],
      [{ __typename: "LabeledEvent", createdAt: "2026-11-01T09:00:00Z", label: { name: "needs-design" } }],
    );

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: false });
  });

  it("reads the Kit's refusal of a Map past the Map cap as the Operator's move, so the session keeps its slot and their reply starts its next turn", async () => {
    const refused = planFor(
      { kind: "agent-run-finished", role: "design", issue: 6, output: JSON.stringify(aMap) },
      snapshotOf(anIssue({ number: 6, labels: ["needs-design"] }), { openMaps: [12] }),
      kitConfig(),
    );
    const refusal = refused.kind === "act" && refused.actions[0]?.kind === "comment" ? refused.actions[0].body : "";

    const issue = await gatheredIssue([{ body: refusal, author: { __typename: "Bot" } }]);

    expect(issue).toMatchObject({ designRounds: 0, turnFailed: true });
    const reply = { kind: "issue-comment-created", issue: 6, commenter: "operator", commenterIsBot: false, body: "Make it a Spec then", comment: 9 } as const;
    expect(planFor(reply, snapshotOf(issue ?? anIssue()), kitConfig())).toMatchObject({
      kind: "act",
      actions: [{ kind: "start-agent-run", role: "design", issue: 6 }],
    });
  });

  describe("its pending prototype request", () => {
    const brief = "- **A**: one long form.\n- **B**: a stepper.\n- **C**: a calendar first.";
    const app = { login: "fabrik-app", __typename: "Bot" };

    /** The prototype request the core posts for an ordinary turn, started by the Operator's reply 9001, that asked for one. */
    function requestComment(): string {
      const output = JSON.stringify({ kind: "prototype", route: "/book", variants: 3, brief, comment: "Prototyping the booking page." });
      const plan = planFor(
        { kind: "agent-run-finished", role: "design", issue: 6, output, startedBy: 9001 },
        snapshotOf(anIssue({ number: 6, labels: ["needs-design"], designRounds: 1 }), { startingComment: { id: 9001, exists: true } }),
        kitConfig({ ui: UI }),
      );
      return plan.kind === "act" && plan.actions[0]?.kind === "comment" ? plan.actions[0].body : "";
    }

    /** The Operator's reply 9001, which approved the Prototype. */
    const approval = { body: "Yes, prototype it.", author: { login: "operator", __typename: "User" }, fullDatabaseId: "9001" };

    it("reads the prototype request the core posted as the session's pending request, with the reply that asked for it", async () => {
      const issue = await gatheredIssue([approval, { body: requestComment(), author: app }]);

      expect(issue?.pendingPrototype).toMatchObject({ request: { route: "/book", variants: 3, brief }, reply: 9001 });
      expect(issue?.unansweredPrototypes).toEqual([{ request: { route: "/book", variants: 3, brief }, reply: 9001 }]);
    });

    it("reads a request another turn's failure notice followed as unanswered, though no longer pending, so its prototype turn still lands", async () => {
      const failed = { body: `${DESIGN_TURN_FAILED_MARKER}\n@operator The Design-session turn run on #6 failed.`, author: app };
      const issue = await gatheredIssue([approval, { body: requestComment(), author: app }, failed], [], "fabrik-app[bot]");

      expect(issue?.pendingPrototype).toBeNull();
      expect(issue?.unansweredPrototypes).toEqual([{ request: { route: "/book", variants: 3, brief }, reply: 9001 }]);
    });

    it("reads a request whose approving reply isn't among the comments it read, deleted or older than them, as not pending", async () => {
      const issue = await gatheredIssue([{ body: "Earlier.", author: { login: "operator", __typename: "User" }, fullDatabaseId: "9000" }, { body: requestComment(), author: app }]);

      expect(issue?.pendingPrototype).toBeNull();
    });

    it("counts only a request posted since the issue last got needs-design", async () => {
      const issue = await gatheredIssue(
        [{ body: requestComment(), createdAt: "2026-10-02T09:00:00Z", author: app }],
        [{ __typename: "LabeledEvent", createdAt: "2026-11-01T09:00:00Z", label: { name: "needs-design" } }],
      );

      expect(issue?.pendingPrototype).toBeNull();
    });

    // As byAppOf takes them: the Kit job, which only routes, doesn't know the App's login.
    it("takes only the Fabrik App's request once it knows the App's login, and any bot's while it doesn't, never a person's", async () => {
      const other = { login: "other-app", __typename: "Bot" };
      const person = { login: "jrey", __typename: "User" };

      expect((await gatheredIssue([approval, { body: requestComment(), author: app }], [], "fabrik-app[bot]"))?.pendingPrototype).not.toBeNull();
      expect((await gatheredIssue([approval, { body: requestComment(), author: other }], [], "fabrik-app[bot]"))?.pendingPrototype).toBeNull();
      expect((await gatheredIssue([approval, { body: requestComment(), author: other }]))?.pendingPrototype).not.toBeNull();
      expect((await gatheredIssue([approval, { body: requestComment(), author: person }]))?.pendingPrototype).toBeNull();
    });
  });
});

describe("Gathering the open Maps a Design-session turn's Map is weighed against", () => {
  /** GitHub holding these open wayfinder:map issues, oldest first; the open Maps query is answered from them alone. */
  function githubWithMaps(maps: { number: number; title: string; author: { login: string; __typename: string } }[]) {
    const asked: Record<string, unknown>[] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("labels: [$map]")) {
          asked.push(variables);
          expect(query).toContain("states: OPEN");
          return { repository: { issues: { nodes: maps } } };
        }
        if (query.includes("issue(number: $number)")) return issueData(7);
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  const designTurn = { kind: "agent-run-finished", role: "design", issue: 7, output: "{}" } as const;

  it("holds every open wayfinder:map issue, whoever made it, the Kit or the Operator by hand", async () => {
    const { github, asked } = githubWithMaps([
      { number: 12, title: "Group classes", author: { login: "jrey", __typename: "User" } },
      { number: 14, title: "Online intake", author: { login: "fabrik-app", __typename: "Bot" } },
    ]);

    const snapshot = await gatherSnapshot(github, repo, designTurn, null, APP_LOGIN);

    expect(snapshot.openMaps).toEqual([12, 14]);
    expect(asked).toEqual([expect.objectContaining({ owner: "acme", name: "shop", map: "wayfinder:map" })]);
  });

  it("holds none when no Map is open", async () => {
    const { github } = githubWithMaps([]);

    expect((await gatherSnapshot(github, repo, designTurn, null, APP_LOGIN)).openMaps).toEqual([]);
  });

  it.each([
    ["a Triage run finishing", { kind: "agent-run-finished", role: "triage", issue: 7, output: "{}" }],
    ["a reply in a Design session", { kind: "issue-comment-created", issue: 7, commenter: "operator", commenterIsBot: false, body: "Yes", comment: 9 }],
  ] as const)("isn't gathered for %s", async (_, event) => {
    const { github, asked } = githubWithMaps([{ number: 12, title: "Group classes", author: { login: "jrey", __typename: "User" } }]);

    expect((await gatherSnapshot(github, repo, event, null, APP_LOGIN)).openMaps).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("Gathering a Dispatch check's Tickets", () => {
  it("holds each Ticket's open blockers apart from those closed as not planned, and drops those closed any other way", async () => {
    const github = {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("labels: [$ready]")) {
          return {
            repository: {
              owner: { login: "acme" },
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 6,
                    state: "OPEN",
                    labels: { nodes: [{ name: "ready-for-agent" }] },
                    subIssues: { totalCount: 0 },
                    blockedBy: {
                      nodes: [
                        { number: 10, state: "OPEN", stateReason: null },
                        { number: 9, state: "CLOSED", stateReason: "NOT_PLANNED" },
                        { number: 8, state: "CLOSED", stateReason: "COMPLETED" },
                        { number: 7, state: "CLOSED", stateReason: "DUPLICATE" },
                      ],
                    },
                    closedByPullRequestsReferences: { nodes: [] },
                    comments: { nodes: [] },
                  },
                ],
              },
              pullRequests: { nodes: [] },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "dispatch-check" }, null, null, actionsWith([]) as unknown as GitHub);

    expect(snapshot.dispatch?.tickets).toMatchObject([{ number: 6, openBlockers: [10], notPlannedBlockers: [9] }]);
  });

  /** The read-only API, holding one open ready-for-agent Ticket, #6, with these comments and closing PRs, and no research Decision. */
  function ticketGitHub(
    comments: { body: string; author: { login: string; __typename: string } | null }[],
    closedBy: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[] = [],
  ): GitHub {
    return {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("labels: [$ready]")) {
          // Each comment's author by login, so the Fabrik App's comments are told apart from another bot's.
          expect(query).toContain("comments(last: 100) { nodes { body author { login __typename } } }");
          const ticket = {
            number: 6,
            state: "OPEN",
            labels: { nodes: [{ name: "ready-for-agent" }] },
            subIssues: { totalCount: 0 },
            blockedBy: { nodes: [] },
            closedByPullRequestsReferences: { nodes: closedBy },
            comments: { nodes: comments },
          };
          return {
            repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ticket] }, pullRequests: { nodes: [] } },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      },
    } as unknown as GitHub;
  }

  // GitHub sometimes leaves a Ticket open after its PR merged, and still lists that PR (#543).
  it("holds a Ticket's merged closing PRs apart from its open ones", async () => {
    const closedBy = [
      { number: 140, state: "MERGED" as const },
      { number: 150, state: "OPEN" as const },
      { number: 131, state: "MERGED" as const },
    ];

    const snapshot = await gatherSnapshot(ticketGitHub([], closedBy), repo, { kind: "dispatch-check" }, null, APP_LOGIN, actionsWith([]) as unknown as GitHub);

    expect(snapshot.dispatch?.tickets[0]).toMatchObject({ openLinkedPullRequests: [150], mergedLinkedPullRequests: [131, 140] });
  });

  const PERSON = { login: "operator", __typename: "User" };
  const OTHER_BOT = { login: "dependabot", __typename: "Bot" };
  const NOTICE = `${IMPLEMENT_RUN_FAILED_MARKER}\n@operator The Implement run on #6 failed: it crashed.`;

  // So a check, the hourly tick's included, leaves a broken Ticket for the Operator to re-add agent:implement (#418).
  it.each([
    ["the Kit's failure notice is its last comment", [{ body: NOTICE, author: APP_BOT }], true],
    ["the Operator has only replied since the Kit's failure notice", [{ body: NOTICE, author: APP_BOT }, { body: "Looking into it", author: PERSON }], true],
    ["the Kit has commented since its failure notice", [{ body: NOTICE, author: APP_BOT }, { body: "Something later.", author: APP_BOT }], false],
    ["a person quoted the failure notice", [{ body: NOTICE, author: PERSON }], false],
    ["another bot posted a look-alike failure notice", [{ body: NOTICE, author: OTHER_BOT }], false],
    ["it has no comments", [], false],
  ])("reads a Ticket's last Implement run as failed only when the Kit's failure notice is its latest word: %s", async (_case, comments, failed) => {
    const snapshot = await gatherSnapshot(ticketGitHub(comments), repo, { kind: "dispatch-check" }, null, APP_LOGIN, actionsWith([]) as unknown as GitHub);

    expect(snapshot.dispatch?.tickets[0]?.lastRunFailed).toBe(failed);
  });
});

/** An open `wayfinder:research` issue as GitHub holds it, by default unassigned, unblocked, under the open Map #3, and with no comments. */
function aResearchNode(
  number: number,
  {
    labels = ["wayfinder:research"],
    assignees = [],
    blockedBy = [],
    parent = { number: 3, state: "OPEN", labels: ["enhancement", "wayfinder:map"] },
    comments = [],
  }: {
    labels?: string[];
    assignees?: string[];
    blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[];
    parent?: GitHubParent | null;
    comments?: { body: string; author: { login: string; __typename: string } | null }[];
  } = {},
) {
  return {
    number,
    state: "OPEN",
    labels: { nodes: labels.map((name) => ({ name })) },
    assignees: { nodes: assignees.map((login) => ({ login })) },
    blockedBy: { nodes: blockedBy },
    parent: parent === null ? null : { number: parent.number, state: parent.state, labels: { nodes: parent.labels.map((name) => ({ name })) } },
    comments: { nodes: comments },
  };
}

describe("Gathering a Dispatch check's research Decisions", () => {
  /** The read-only API, holding no ready-for-agent Ticket and these pages of open `wayfinder:research` issues. */
  function researchGitHub(pages: ReturnType<typeof aResearchNode>[][]): GitHub {
    return {
      async graphql(query: string, variables: { after: string | null; research?: string }): Promise<unknown> {
        if (query.includes("labels: [$ready]")) {
          return { repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, pullRequests: { nodes: [] } } };
        }
        if (query.includes("labels: [$research]")) {
          expect(variables.research).toBe("wayfinder:research");
          // Each comment's author by login, so the Fabrik App's comments are told apart from another bot's.
          expect(query).toContain("nodes { body author { login __typename } }");
          const page = variables.after === null ? 0 : Number(variables.after);
          const hasNextPage = page + 1 < pages.length;
          return {
            repository: {
              issues: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(page + 1) : null }, nodes: pages[page] ?? [] },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
  }

  async function gathered(pages: ReturnType<typeof aResearchNode>[][]) {
    const snapshot = await gatherSnapshot(researchGitHub(pages), repo, { kind: "dispatch-check" }, null, APP_LOGIN, actionsWith([]) as unknown as GitHub);
    return snapshot.dispatch?.researchDecisions;
  }

  it("holds each one, on every page, with its labels, assignees, open blockers and parent Map's state", async () => {
    const decisions = await gathered([
      [
        aResearchNode(12, {
          labels: ["wayfinder:research", "agent:research"],
          assignees: ["jrey"],
          blockedBy: [
            { number: 10, state: "OPEN" },
            { number: 9, state: "CLOSED" },
          ],
        }),
      ],
      [
        aResearchNode(14, { parent: { number: 5, state: "CLOSED", labels: ["wayfinder:map"] } }),
        aResearchNode(15, { parent: null }),
      ],
    ]);

    expect(decisions).toEqual([
      {
        number: 12,
        open: true,
        labels: ["wayfinder:research", "agent:research"],
        assignees: ["jrey"],
        openBlockers: [10],
        parentIssue: { number: 3, open: true, labels: ["enhancement", "wayfinder:map"] },
        lastRunFailed: false,
      },
      { number: 14, open: true, labels: ["wayfinder:research"], assignees: [], openBlockers: [], parentIssue: { number: 5, open: false, labels: ["wayfinder:map"] }, lastRunFailed: false },
      { number: 15, open: true, labels: ["wayfinder:research"], assignees: [], openBlockers: [], parentIssue: null, lastRunFailed: false },
    ]);
  });

  it("holds the Research runs in flight beside the Implement runs, read through the Actions token", async () => {
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Research", status: "in_progress" }] },
      { id: 2, status: "queued", jobs: [{ name: "fabrik / Implement", status: "queued" }, { name: "fabrik / Research", status: "queued" }] },
    ]);

    const snapshot = await gatherSnapshot(researchGitHub([]), repo, { kind: "dispatch-check" }, null, null, actions as unknown as GitHub);

    expect(snapshot.dispatch).toMatchObject({ implementRunsInProgress: 1, researchRunsInProgress: 2 });
  });

  const PERSON = { login: "operator", __typename: "User" };
  const OTHER_BOT = { login: "dependabot", __typename: "Bot" };
  const NOTICE = `${RESEARCH_RUN_FAILED_MARKER}\n@operator The Research run on #12 failed: it crashed.`;

  it.each([
    ["the Kit's failure notice is its last comment", [{ body: NOTICE, author: APP_BOT }], true],
    ["the Operator has only replied since the Kit's failure notice", [{ body: NOTICE, author: APP_BOT }, { body: "Looking into it", author: PERSON }], true],
    ["another bot has commented since the Kit's failure notice", [{ body: NOTICE, author: APP_BOT }, { body: "Bumped a dependency.", author: OTHER_BOT }], true],
    ["the Kit has commented since its failure notice, as a later run's resolution does", [{ body: NOTICE, author: APP_BOT }, { body: "**Resolved.** The gist.", author: APP_BOT }], false],
    ["a person quoted the failure notice", [{ body: NOTICE, author: PERSON }], false],
    ["another bot posted a look-alike failure notice", [{ body: NOTICE, author: OTHER_BOT }], false],
    ["it has no comments", [], false],
  ])("reads its last run as failed only when the Kit's failure notice is its latest run's word: %s", async (_case, comments, failed) => {
    const decisions = await gathered([[aResearchNode(12, { comments })]]);

    expect(decisions?.[0]?.lastRunFailed).toBe(failed);
  });
});

describe("Gathering a weekly run's gate issues as it fails", () => {
  const failed = { kind: "agent-run-failed", role: "audit", issue: 98, runUrl: "https://github.com/acme/shop/actions/runs/42", jobResult: "failure", secretsStep: "success", report: null } as const;
  const EARLIER = { number: 97, title: "Audit: week of 2026-11-02", state: "CLOSED", stateReason: "NOT_PLANNED", createdAt: "2026-11-08T00:05:00Z", body: `The Auditor's run failed: it crashed.\n\n<!-- fabrik:audit ${AUDITED_SHA} -->\n<!-- fabrik:audit-failed -->`, author: APP_BOT };
  const PENDING = { number: 98, title: "Audit: week of 2026-11-02", state: "OPEN", stateReason: null, createdAt: "2026-11-08T02:05:00Z", body: auditBody(AUDITED_SHA, "pending"), author: APP_BOT };

  /** The pending Audit #98 as issueGitHub holds it, with these `fabrik:audit` issues, counting the weekly issue reads. */
  function githubWith(labels: string[], nodes: unknown[]) {
    const issue = issueGitHub({ author: APP_BOT, body: auditBody(AUDITED_SHA, "pending"), labels });
    const reads: unknown[] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("defaultBranchRef")) {
          reads.push(variables["label"]);
          return { repository: { defaultBranchRef: null, issues: { nodes: variables["label"] === "fabrik:audit" ? nodes : [] } } };
        }
        return issue.graphql(query, variables);
      },
    } as unknown as GitHub;
    return { github, reads };
  }

  it("holds the Audit's gate issues, so the week's second failure tells the Operator", async () => {
    const { github } = githubWith(["fabrik:audit"], [PENDING, EARLIER]);

    const snapshot = await gatherSnapshot(github, repo, failed, null, APP_LOGIN);

    expect(snapshot.weeklyIssues?.map(({ number, byApp }) => ({ number, byApp }))).toEqual([
      { number: 98, byApp: true },
      { number: 97, byApp: true },
    ]);
    expect(notificationsOf(planFor(failed, snapshot, kitConfig()), snapshot.operator)).toEqual(["mention on #98"]);
  });

  it("reads none for an issue that's neither an Audit nor a Retro, or an event that fails no weekly run", async () => {
    const other = githubWith(["needs-triage"], [PENDING, EARLIER]);
    const commented = githubWith(["fabrik:audit"], [PENDING, EARLIER]);

    const snapshots = [
      await gatherSnapshot(other.github, repo, failed, null, APP_LOGIN),
      await gatherSnapshot(commented.github, repo, { kind: "label-added", issue: 98, label: "needs-triage" }, null, APP_LOGIN),
    ];

    expect(snapshots.map((snapshot) => snapshot.weeklyIssues)).toEqual([null, null]);
    expect([...other.reads, ...commented.reads]).toEqual([]);
  });
});

describe("Gathering a scheduled tick's ready-for-agent Tickets (#543)", () => {
  /** The read-only API, holding these open ready-for-agent Tickets, each closed by these PRs, and no other issue or PR. */
  function githubWith(closedBy: Record<number, { number: number; state: "OPEN" | "CLOSED" | "MERGED" }[]>) {
    return {
      async graphql(query: string): Promise<unknown> {
        const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
        if (query.includes("labels: [$ready]")) {
          const nodes = Object.entries(closedBy).map(([number, prs]) => ({
            number: Number(number),
            state: "OPEN",
            labels: { nodes: [{ name: "ready-for-agent" }] },
            subIssues: { totalCount: 0 },
            blockedBy: { nodes: [] },
            closedByPullRequestsReferences: { nodes: prs },
            comments: { nodes: [] },
          }));
          return { repository: { owner: { login: "acme" }, issues: { ...none, nodes }, pullRequests: { nodes: [] } } };
        }
        return { repository: { owner: { login: "acme" }, issues: none, pullRequests: none } };
      },
    } as unknown as GitHub;
  }

  it("holds each Ticket's merged closing PRs, a person's as well as an agent's, which the tick closes it for", async () => {
    const github = githubWith({ 130: [{ number: 131, state: "MERGED" }], 234: [{ number: 240, state: "MERGED" }, { number: 250, state: "OPEN" }], 300: [] });

    const snapshot = await gatherSnapshot(github, repo, { kind: "scheduled-tick", now: "2026-11-10T04:00:00Z" }, null, APP_LOGIN);

    expect(snapshot.readyTickets).toMatchObject([
      { number: 130, open: true, mergedLinkedPullRequests: [131], openLinkedPullRequests: [] },
      { number: 234, open: true, mergedLinkedPullRequests: [240], openLinkedPullRequests: [250] },
      { number: 300, open: true, mergedLinkedPullRequests: [], openLinkedPullRequests: [] },
    ]);
  });

  it("isn't gathered for any other event", async () => {
    const github = githubWith({ 130: [{ number: 131, state: "MERGED" }] });

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: "f".repeat(40) }, null, APP_LOGIN);

    expect(snapshot.readyTickets).toBeNull();
  });
});

describe("Gathering a scheduled tick's audit slice", () => {
  const HEAD = "c".repeat(40);

  /** The read-only API, holding this default branch head and these `fabrik:audit` issues, newest first, and no other issue or PR. */
  function githubWith(defaultBranchRef: { target: { oid: string } } | null, nodes: unknown[]) {
    return {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("defaultBranchRef")) {
          return { repository: { defaultBranchRef, issues: { nodes: variables["label"] === "fabrik:audit" ? nodes : [] } } };
        }
        const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
        return { repository: { owner: { login: "acme" }, issues: none, pullRequests: none } };
      },
    } as unknown as GitHub;
  }

  const tick = { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" } as const;

  it("holds the default branch's head and each Audit issue, open or closed, with its title, telling the Fabrik App's from a person's or another bot's", async () => {
    const github = githubWith({ target: { oid: HEAD } }, [
      { number: 97, title: "My audit", state: "OPEN", stateReason: null, createdAt: "2026-11-08T00:05:00Z", body: "Quoting <!-- fabrik:audit-pending -->", author: { login: "jrey8343", __typename: "User" } },
      { number: 96, title: "Audit: week of 2026-11-02", state: "OPEN", stateReason: null, createdAt: "2026-11-08T00:04:30Z", body: "<!-- fabrik:audit-pending -->", author: { login: "other-app", __typename: "Bot" } },
      { number: 95, title: "Audit: week of 2026-11-02", state: "CLOSED", stateReason: "NOT_PLANNED", createdAt: "2026-11-08T00:04:00Z", body: "failed", author: { login: "fabrik-app", __typename: "Bot" } },
      { number: 90, title: "Audit: week of 2026-10-26", state: "CLOSED", stateReason: "COMPLETED", createdAt: "2026-11-01T00:05:00Z", body: "filled", author: { login: "fabrik-app", __typename: "Bot" } },
      { number: 85, title: "Audit: week of 2026-10-19", state: "OPEN", stateReason: "REOPENED", createdAt: "2026-10-25T00:05:00Z", body: "", author: null },
    ]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.audit).toEqual({
      head: HEAD,
      issues: [
        { number: 97, title: "My audit", open: true, stateReason: null, createdAt: "2026-11-08T00:05:00Z", byApp: false, body: "Quoting <!-- fabrik:audit-pending -->" },
        { number: 96, title: "Audit: week of 2026-11-02", open: true, stateReason: null, createdAt: "2026-11-08T00:04:30Z", byApp: false, body: "<!-- fabrik:audit-pending -->" },
        { number: 95, title: "Audit: week of 2026-11-02", open: false, stateReason: "not_planned", createdAt: "2026-11-08T00:04:00Z", byApp: true, body: "failed" },
        { number: 90, title: "Audit: week of 2026-10-26", open: false, stateReason: "completed", createdAt: "2026-11-01T00:05:00Z", byApp: true, body: "filled" },
        { number: 85, title: "Audit: week of 2026-10-19", open: true, stateReason: "reopened", createdAt: "2026-10-25T00:05:00Z", byApp: false, body: "" },
      ],
    });
  });

  it("holds no head for a repo whose default branch has no commits", async () => {
    const snapshot = await gatherSnapshot(githubWith(null, []), repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.audit).toEqual({ head: null, issues: [] });
  });

  it("isn't gathered for any other event", async () => {
    const snapshot = await gatherSnapshot(githubWith({ target: { oid: HEAD } }, []), repo, { kind: "kit-config-changed", head: "f".repeat(40) }, null, "fabrik-app[bot]");

    expect(snapshot.audit).toBeNull();
  });
});

describe("Gathering a scheduled tick's retro slice", () => {
  /** Saturday 2026-11-07 04:00 UTC. A first Retro's window starts 7 days before: 2026-10-31 04:00 UTC. */
  const tick = { kind: "scheduled-tick", now: "2026-11-07T04:00:00.000Z" } as const;

  /** A `fabrik:retro` issue node as the query returns it: by default the App's last Retro, whose window ended 2026-11-04 04:00 UTC. */
  function aRetroNode(overrides: Record<string, unknown> = {}) {
    return {
      number: 80,
      title: "Retro: week of 2026-11-02",
      state: "CLOSED",
      stateReason: "COMPLETED",
      createdAt: "2026-11-04T04:00:04Z",
      body: retroBody("2026-11-04T04:00:00.000Z"),
      author: { login: "fabrik-app", __typename: "Bot" },
      ...overrides,
    };
  }

  /** A merged or closed PR node: by default an agent PR the Fabrik App opened, merged at `closedAt`. */
  function aClosedPullRequest(closedAt: string, overrides: Record<string, unknown> = {}) {
    return { headRefName: "fabrik/ticket-7", closedAt, updatedAt: closedAt, author: { __typename: "Bot" }, ...overrides };
  }

  /** An issue node the Operator opened, by default with an escape marker. */
  function anOperatorIssue(createdAt: string, body = "Make the cart module deeper\n\n<!-- fabrik:escape strong #31 -->") {
    return { createdAt, body };
  }

  /**
   * The read-only API, holding these `fabrik:retro` issues, these pages of
   * merged and closed PRs, newest-updated first, and the issues the Operator
   * opened, newest first. The queries it was asked are in `asked`.
   */
  function githubWith({
    retros = [],
    pullRequestPages = [[]],
    operatorIssues = [],
  }: { retros?: unknown[]; pullRequestPages?: unknown[][]; operatorIssues?: unknown[] } = {}) {
    const asked: { query: string; variables: Record<string, unknown> }[] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        asked.push({ query, variables });
        if (query.includes("labels: [$label]")) {
          return { repository: { defaultBranchRef: null, issues: { nodes: variables["label"] === "fabrik:retro" ? retros : [] } } };
        }
        if (query.includes("states: [MERGED, CLOSED]")) {
          const at = typeof variables["after"] === "string" ? Number(variables["after"]) : 0;
          const hasNextPage = at + 1 < pullRequestPages.length;
          return { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(at + 1) : null }, nodes: pullRequestPages[at] } } };
        }
        if (query.includes("createdBy: $operator")) {
          return { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: operatorIssues } } };
        }
        const ready = noReadyTicket(query);
        if (ready !== undefined) return ready;
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  /** The store's metadata as a token scoped to it reads it. */
  function storeThatIs(visibility: "private" | "public") {
    return {
      async rest(method: string, path: string): Promise<unknown> {
        expect([method, path]).toEqual(["GET", "/repos/jrey8343/fabrik-runs"]);
        return { full_name: "jrey8343/fabrik-runs", private: visibility === "private" };
      },
    } as unknown as GitHub;
  }

  const gather = (github: GitHub, store: GitHub | null = storeThatIs("private"), operator: string | null = null) =>
    gatherSnapshot(github, repo, tick, operator, "fabrik-app[bot]", null, store);

  it("holds each Retro issue, open or closed, with its title, telling the Fabrik App's from a person's or another bot's", async () => {
    const { github } = githubWith({
      retros: [
        aRetroNode({ number: 97, title: "My retro", state: "OPEN", stateReason: null, createdAt: "2026-11-07T00:05:00Z", body: "Quoting <!-- fabrik:retro-pending -->", author: { login: "jrey8343", __typename: "User" } }),
        aRetroNode({ number: 96, state: "OPEN", stateReason: null, body: "<!-- fabrik:retro-pending -->", author: { login: "other-app", __typename: "Bot" } }),
        aRetroNode({ number: 95, stateReason: "NOT_PLANNED", body: "failed" }),
        aRetroNode({ number: 85, state: "OPEN", stateReason: "REOPENED", body: "", author: null }),
      ],
    });

    const snapshot = await gather(github);

    expect(snapshot.retro?.issues).toEqual([
      { number: 97, title: "My retro", open: true, stateReason: null, createdAt: "2026-11-07T00:05:00Z", byApp: false, body: "Quoting <!-- fabrik:retro-pending -->" },
      { number: 96, title: "Retro: week of 2026-11-02", open: true, stateReason: null, createdAt: "2026-11-04T04:00:04Z", byApp: false, body: "<!-- fabrik:retro-pending -->" },
      { number: 95, title: "Retro: week of 2026-11-02", open: false, stateReason: "not_planned", createdAt: "2026-11-04T04:00:04Z", byApp: true, body: "failed" },
      { number: 85, title: "Retro: week of 2026-11-02", open: true, stateReason: "reopened", createdAt: "2026-11-04T04:00:04Z", byApp: false, body: "" },
    ]);
  });

  describe("holds the store as ready", () => {
    it("when the Fabrik App is on fabrik-runs and it's private", async () => {
      expect((await gather(githubWith().github, storeThatIs("private"))).retro?.storeReady).toBe(true);
    });

    it("never when it's public, since a Retro's evidence holds Product repos' issues and code", async () => {
      expect((await gather(githubWith().github, storeThatIs("public"))).retro?.storeReady).toBe(false);
    });

    it("never when the run found no Fabrik App on fabrik-runs, and so has no token to read it with", async () => {
      expect((await gather(githubWith().github, null)).retro?.storeReady).toBe(false);
    });
  });

  describe("holds whether an agent PR merged or closed since the window a Retro opened now would start", () => {
    const closed = async (options: Parameters<typeof githubWith>[0]) => (await gather(githubWith(options).github)).retro?.agentPullRequestClosed;

    it("over the 7 days before the tick on a first Retro", async () => {
      expect(await closed({ pullRequestPages: [[aClosedPullRequest("2026-10-31T04:30:00Z")]] })).toBe(true);
      expect(await closed({ pullRequestPages: [[aClosedPullRequest("2026-10-31T03:30:00Z")]] })).toBe(false);
    });

    it("since the last Retro's window end", async () => {
      expect(await closed({ retros: [aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-04T04:30:00Z")]] })).toBe(true);
      expect(await closed({ retros: [aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-04T03:30:00Z")]] })).toBe(false);
    });

    it("since the window end of the Retro before a failed one, which is never the last Retro", async () => {
      const failed = aRetroNode({ number: 85, stateReason: "NOT_PLANNED", createdAt: "2026-11-06T04:00:04Z", body: retroBody("2026-11-06T04:00:00.000Z", "failed") });

      expect(await closed({ retros: [failed, aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-05T04:00:00Z")]] })).toBe(true);
    });

    it("since the window end of the Fabrik App's last Retro, never a person's", async () => {
      const person = aRetroNode({ number: 86, createdAt: "2026-11-06T04:00:04Z", body: retroBody("2026-11-06T04:00:00.000Z"), author: { login: "jrey8343", __typename: "User" } });

      expect(await closed({ retros: [person, aRetroNode()], pullRequestPages: [[aClosedPullRequest("2026-11-05T04:00:00Z")]] })).toBe(true);
    });

    it("counting only agent PRs, by when they closed rather than when they were last touched", async () => {
      const window = "2026-11-02T04:00:00Z";
      const person = aClosedPullRequest(window, { headRefName: "fix-cart", author: { __typename: "User" } });
      const dependabot = aClosedPullRequest(window, { headRefName: "dependabot/npm_and_yarn/vite-7.1.0" });
      const commentedOnSince = aClosedPullRequest("2026-10-20T04:00:00Z", { updatedAt: window });

      expect(await closed({ pullRequestPages: [[person, dependabot, commentedOnSince]] })).toBe(false);
    });

    it("reading on to older pages until one reaches back past the window start", async () => {
      const others = Array.from({ length: 3 }, () => aClosedPullRequest("2026-11-06T04:00:00Z", { headRefName: "fix-cart", author: { __typename: "User" } }));

      expect(await closed({ pullRequestPages: [others, [aClosedPullRequest("2026-11-01T04:00:00Z")]] })).toBe(true);
    });
  });

  describe("holds whether the Operator filed an escape since the window a Retro opened now would start", () => {
    const filed = async (options: Parameters<typeof githubWith>[0], operator: string | null = null) =>
      (await gather(githubWith(options).github, storeThatIs("private"), operator)).retro?.escapeFiled;

    it("when an issue the Operator opened in the window has an escape marker", async () => {
      expect(await filed({ retros: [aRetroNode()], operatorIssues: [anOperatorIssue("2026-11-05T04:00:00Z")] })).toBe(true);
    });

    it("not for one with no escape marker, or opened before the window start", async () => {
      expect(await filed({ retros: [aRetroNode()], operatorIssues: [anOperatorIssue("2026-11-05T04:00:00Z", "The cart rounds wrong")] })).toBe(false);
      expect(await filed({ retros: [aRetroNode()], operatorIssues: [anOperatorIssue("2026-11-03T04:00:00Z")] })).toBe(false);
    });

    it.each([
      ["the Kit config's operator", "jrey8343", "jrey8343"],
      ["the repo's owner by default", null, "acme"],
    ])("reading only the issues %s opened", async (_, operator, login) => {
      const { github, asked } = githubWith();

      await gather(github, storeThatIs("private"), operator);

      expect(asked.filter(({ query }) => query.includes("createdBy: $operator")).map(({ variables }) => variables["operator"])).toEqual([login]);
    });
  });

  it("isn't gathered for any other event", async () => {
    const snapshot = await gatherSnapshot(githubWith().github, repo, { kind: "kit-config-changed", head: "f".repeat(40) }, null, "fabrik-app[bot]", null, storeThatIs("private"));

    expect(snapshot.retro).toBeNull();
  });
});

const APP = { login: "fabrik-app", __typename: "Bot" };

/**
 * The answer to the retro slice's queries, which every scheduled tick asks
 * (gatherRetroSlice): no PR merged or closed, and no issue the Operator
 * opened. Undefined for any other query.
 */
function nothingNewForTheRetro(query: string): unknown {
  const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  if (query.includes("states: [MERGED, CLOSED]")) return { repository: { pullRequests: none } };
  if (query.includes("createdBy: $operator")) return { repository: { issues: none } };
  return undefined;
}

/** The answer to the scheduled tick's read of its ready-for-agent Tickets (#543): none open. Undefined for any other query. */
function noReadyTicket(query: string): unknown {
  if (!query.includes("labels: [$ready]")) return undefined;
  return { repository: { owner: { login: "acme" }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, pullRequests: { nodes: [] } } };
}

describe("Gathering the issues and PRs held runs are on, for a scheduled tick and whatever may free a Subscription", () => {
  const tick = { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" } as const;
  const heldMarker = (issue: number, role: string, label: string | null) =>
    `<!-- fabrik:held ${JSON.stringify({ issue, role, label })} -->`;

  /**
   * The read-only API, holding one weekly-limit issue with these comments,
   * these issues and PRs by number, and a closed issue with `closedLabels`
   * for an issue-closed event.
   */
  function githubWith(comments: string[], targets: Record<number, unknown>, closedLabels: string[] = [], closedComments: string[] = []) {
    const asked: number[][] = [];
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("closedKitIssue: issue(number: $number)")) {
          return {
            repository: {
              closedKitIssue: {
                number: variables["number"],
                body: "<!-- fabrik:notified -->",
                author: APP,
                labels: { nodes: closedLabels.map((name) => ({ name })) },
                comments: { nodes: [...closedComments.map((body) => ({ body, author: APP })), { body: heldMarker(11, "triage", "needs-triage"), author: { login: "mallory", __typename: "User" } }] },
              },
            },
          };
        }
        if (query.includes("issue(number: $number)")) {
          const data = issueData(variables["number"] as number);
          return {
            repository: {
              ...data.repository,
              issue: { ...data.repository.issue, state: "CLOSED", labels: { nodes: closedLabels.map((name) => ({ name })) } },
            },
          };
        }
        if (query.includes("issueOrPullRequest")) {
          const numbers = Object.entries(variables).filter(([name]) => /^n\d+$/.test(name)).map(([, value]) => value as number);
          asked.push(numbers);
          return {
            repository: Object.fromEntries(
              Object.entries(variables)
                .filter(([name]) => /^n\d+$/.test(name))
                .map(([name, number]) => [`t${name.slice(1)}`, targets[number as number] ?? null]),
            ),
          };
        }
        if (query.includes("defaultBranchRef")) return { repository: { defaultBranchRef: null, issues: { nodes: [] } } };
        const retro = nothingNewForTheRetro(query);
        if (retro !== undefined) return retro;
        const ready = noReadyTicket(query);
        if (ready !== undefined) return ready;
        return {
          repository: {
            owner: { login: "acme" },
            issues: {
              nodes: [
                {
                  number: 41,
                  body: "<!-- fabrik:notified -->",
                  author: APP,
                  labels: { nodes: [{ name: "fabrik:weekly-limit" }] },
                  comments: { nodes: comments.map((body) => ({ body, author: APP })) },
                },
              ],
            },
          },
        };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  it("holds each issue or PR a held marker names, once, with its state, labels and whether it's a draft", async () => {
    const { github } = githubWith(
      [heldMarker(7, "triage", "needs-triage"), `${heldMarker(50, "review", "agent:review")}\n${heldMarker(7, "triage", "needs-triage")}`, heldMarker(9, "implement", "agent:implement")],
      {
        7: { __typename: "Issue", number: 7, state: "OPEN", body: "", author: { login: "jrey", __typename: "User" }, labels: { nodes: [{ name: "bug" }] } },
        50: { __typename: "PullRequest", number: 50, state: "OPEN", isDraft: true, body: "Closes #7", author: { login: "fabrik-app", __typename: "Bot" }, labels: { nodes: [] } },
      },
    );

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.held).toEqual([
      { number: 7, open: true, labels: ["bug"], draft: null, byApp: false, body: "" },
      { number: 50, open: true, labels: [], draft: true, byApp: true, body: "Closes #7" },
    ]);
  });

  it("holds when the App last added each label to a held run's issue or PR, and when each held marker was posted, so a resume that landed isn't run twice (#438)", async () => {
    const labelled = (name: string, createdAt: string, login: string, __typename = "Bot") => ({
      __typename: "LabeledEvent",
      createdAt,
      label: { name },
      actor: { login, __typename },
    });
    const { github } = githubWith([], {
      50: {
        __typename: "PullRequest",
        number: 50,
        state: "OPEN",
        isDraft: true,
        body: "",
        author: { login: "fabrik-app", __typename: "Bot" },
        labels: { nodes: [] },
        timelineItems: {
          nodes: [
            labelled("agent:review", "2026-11-01T09:00:00Z", "fabrik-app"),
            labelled("agent:review", "2026-11-08T11:00:05Z", "fabrik-app"),
            labelled("agent:review", "2026-11-08T12:00:00Z", "jrey", "User"),
            labelled("bug", "2026-11-08T12:00:00Z", "jrey", "User"),
          ],
        },
      },
    });
    const withTimes = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        const data = (await github.graphql(query, variables)) as { repository: { owner?: unknown; issues?: { nodes: Record<string, unknown>[] } } };
        const issues = data.repository.issues?.nodes;
        // Only the open Kit-owned issues' answer names the owner, besides the tick's ready-for-agent Tickets'.
        if (issues === undefined || data.repository.owner === undefined || noReadyTicket(query) !== undefined) return data;
        return {
          ...data,
          repository: {
            ...data.repository,
            issues: {
              nodes: issues.map((issue) => ({
                ...issue,
                createdAt: "2026-11-07T09:00:00Z",
                comments: { nodes: [{ body: heldMarker(50, "review", "agent:review"), createdAt: "2026-11-08T09:00:00Z", author: APP }] },
              })),
            },
          },
        };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(withTimes, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues[0]).toMatchObject({ createdAt: "2026-11-07T09:00:00Z", commentedAt: ["2026-11-08T09:00:00Z"] });
    expect(snapshot.held).toEqual([
      { number: 50, open: true, labels: [], draft: true, byApp: true, body: "", labeledAt: { "agent:review": "2026-11-08T11:00:05Z" } },
    ]);
  });

  it("asks nothing when no run is held", async () => {
    const { github, asked } = githubWith([], {});

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.held).toEqual([]);
    expect(asked).toEqual([]);
  });

  const issue7 = { __typename: "Issue", number: 7, state: "OPEN", body: "", author: { login: "jrey", __typename: "User" }, labels: { nodes: [{ name: "bug" }] } };
  const heldOn7 = [{ number: 7, open: true, labels: ["bug"], draft: null, byApp: false, body: "" }];

  it("is gathered when a usage-credits, token-rotation or weekly-limit issue closes, since that may free a Subscription (#439)", async () => {
    for (const label of ["fabrik:usage-credits", "fabrik:token-rotation", "fabrik:weekly-limit"]) {
      const { github } = githubWith([heldMarker(7, "triage", "needs-triage")], { 7: issue7 }, ["ready-for-human", label]);

      const snapshot = await gatherSnapshot(github, repo, { kind: "issue-closed", issue: 60 }, null, "fabrik-app[bot]");

      expect(snapshot.held).toEqual(heldOn7);
    }
  });

  it("holds a weekly-limit issue closed by hand, with the App's own text, and gathers what its held markers name too (#440)", async () => {
    const issue8 = { ...issue7, number: 8 };
    const { github, asked } = githubWith([heldMarker(7, "triage", "needs-triage")], { 7: issue7, 8: issue8 }, ["fabrik:weekly-limit"], [
      heldMarker(8, "triage", "needs-triage"),
    ]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "issue-closed", issue: 60 }, null, "fabrik-app[bot]");

    expect(snapshot.closedKitIssue).toEqual({
      number: 60,
      labels: ["fabrik:weekly-limit"],
      body: "<!-- fabrik:notified -->",
      comments: [heldMarker(8, "triage", "needs-triage")],
    });
    expect(asked).toEqual([[7, 8]]);
    expect(snapshot.held).toEqual([...heldOn7, { ...heldOn7[0], number: 8 }]);
  });

  it("holds a usage-credits or token-rotation issue closed by hand too, and gathers what its held markers name (#470)", async () => {
    for (const label of ["fabrik:usage-credits", "fabrik:token-rotation"]) {
      const { github, asked } = githubWith([], { 8: { ...issue7, number: 8 } }, ["ready-for-human", label], [heldMarker(8, "triage", "needs-triage")]);

      const snapshot = await gatherSnapshot(github, repo, { kind: "issue-closed", issue: 60 }, null, "fabrik-app[bot]");

      expect(snapshot.closedKitIssue).toMatchObject({ number: 60, labels: ["ready-for-human", label] });
      expect(asked).toEqual([[8]]);
    }
  });

  it("holds no closed Kit-owned issue for any other issue closing", async () => {
    const { github } = githubWith([], {}, ["ready-for-agent"]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "issue-closed", issue: 60 }, null, "fabrik-app[bot]");

    expect(snapshot.closedKitIssue).toBeNull();
  });

  it("is gathered when the Kit config changes, since a Subscription newly listed is free (#439)", async () => {
    const { github } = githubWith([heldMarker(7, "triage", "needs-triage")], { 7: issue7 });

    const snapshot = await gatherSnapshot(github, repo, { kind: "kit-config-changed", head: "f".repeat(40) }, null, "fabrik-app[bot]");

    expect(snapshot.held).toEqual(heldOn7);
  });

  it("isn't gathered for any other event, a Ticket closing among them", async () => {
    const { github } = githubWith([heldMarker(7, "triage", "needs-triage")], { 7: issue7 }, ["ready-for-agent"]);

    const closed = await gatherSnapshot(github, repo, { kind: "issue-closed", issue: 9 }, null, "fabrik-app[bot]");
    const pushed = await gatherSnapshot(github, repo, { kind: "main-pushed", head: "f".repeat(40) }, null, "fabrik-app[bot]");

    expect(closed.held).toBeNull();
    expect(pushed.held).toBeNull();
  });
});

describe("Gathering the PRs an Auditor named", () => {
  /** The read-only API, holding Audit #97 and these PRs by number; any other number is no PR, which GitHub answers with a 404. */
  function githubWith(pulls: Record<number, unknown>) {
    return {
      async graphql(query: string): Promise<unknown> {
        if (query.includes("issue(number: $number)")) {
          return {
            repository: {
              owner: { login: "acme" },
              issue: {
                number: 97,
                state: "OPEN",
                author: { login: "fabrik-app", __typename: "Bot" },
                body: "Reading.\n\n<!-- fabrik:audit-pending -->",
                labels: { nodes: [{ name: "fabrik:audit" }] },
                parent: null,
                comments: { nodes: [] },
                timelineItems: { nodes: [] },
                closedByPullRequestsReferences: { nodes: [] },
                blockedBy: { nodes: [] },
                blocking: { nodes: [] },
              },
            },
          };
        }
        return { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
      async rest(method: string, path: string, _body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
        const pull = /^\/repos\/acme\/shop\/pulls\/(\d+)$/.exec(path);
        if (method !== "GET" || pull === null) throw new Error(`Unexpected call: ${method} ${path}`);
        const found = pulls[Number(pull[1])];
        if (found !== undefined) return found;
        // As the real client does: a 404 is null only when the call allows it.
        if (options.allowNotFound === true) return null;
        throw new Error(`GitHub GET ${path} failed: 404`);
      },
    } as unknown as GitHub;
  }

  const pull = (number: number, merged: boolean, ref: string, type: string) => ({ number, merged, head: { ref }, user: { type } });

  function finished(output: unknown): LoopEvent {
    return {
      kind: "audit-run-finished",
      issue: 97,
      output: typeof output === "string" ? output : JSON.stringify(output),
      window: { kind: "last-days", days: 30 },
      runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
      repoUrl: "https://github.com/acme/shop",
    };
  }

  const candidate = (introducedBy: number[]) => ({
    title: "Make the cart module deeper",
    files: ["src/cart.ts"],
    problem: "p",
    solution: "s",
    benefits: "b",
    before: "flowchart LR\n  a",
    after: "flowchart LR\n  b",
    strength: "strong",
    introducedBy,
  });

  it("holds each PR the reply names once, telling a merged agent PR from the rest and leaving out a number that's no PR, beside the Audit", async () => {
    const github = githubWith({
      31: pull(31, true, "fabrik/ticket-7", "Bot"),
      40: pull(40, false, "fabrik/ticket-8", "Bot"),
      41: pull(41, true, "feature/cart", "User"),
      42: pull(42, true, "fabrik/ticket-9", "User"),
    });

    const snapshot = await gatherSnapshot(
      github,
      repo,
      finished({ candidates: [candidate([31, 40, 404]), candidate([41, 42, 31])], topRecommendation: "Make the cart module deeper" }),
      null,
      "fabrik-app[bot]",
    );

    expect(snapshot.namedPullRequests).toEqual([
      { number: 31, merged: true, headRef: "fabrik/ticket-7", isAgent: true },
      { number: 40, merged: false, headRef: "fabrik/ticket-8", isAgent: true },
      { number: 41, merged: true, headRef: "feature/cart", isAgent: false },
      { number: 42, merged: true, headRef: "fabrik/ticket-9", isAgent: false },
    ]);
    expect(snapshot.issue).toMatchObject({ number: 97, byApp: true, labels: ["fabrik:audit"] });
  });

  it("holds no PRs for a reply that breaks its contract, whose Audit the core then fails", async () => {
    const github = githubWith({ 31: pull(31, true, "fabrik/ticket-7", "Bot") });

    const snapshot = await gatherSnapshot(github, repo, finished("not JSON, though it names #31"), null, "fabrik-app[bot]");

    expect(snapshot.namedPullRequests).toEqual([]);
  });

  it("isn't gathered for any other event", async () => {
    const snapshot = await gatherSnapshot(githubWith({}), repo, { kind: "kit-config-changed", head: "f".repeat(40) }, null, "fabrik-app[bot]");

    expect(snapshot.namedPullRequests).toBeNull();
  });
});

describe("Gathering a Design-session turn's starting reply", () => {
  const issueData = {
    repository: {
      owner: { login: "acme" },
      issue: {
        number: 7,
        state: "OPEN",
        author: { login: "someone" },
        labels: { nodes: [{ name: "needs-design" }] },
        parent: null,
        comments: { nodes: [] },
        timelineItems: { nodes: [] },
        closedByPullRequestsReferences: { nodes: [] },
        blockedBy: { nodes: [] },
        blocking: { nodes: [] },
      },
    },
  };

  /** The Fabrik App's API, where GET on the reply answers as `reply` does. */
  function githubWhere(reply: (options: { allowNotFound?: boolean }) => unknown) {
    const reads: string[] = [];
    const github = {
      async graphql(query: string): Promise<unknown> {
        return query.includes("issue(number: $number)") ? issueData : { repository: { owner: { login: "acme" }, issues: { nodes: [] } } };
      },
      async rest(method: string, path: string, _body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
        reads.push(`${method} ${path}`);
        return reply(options);
      },
    } as unknown as GitHub;
    return { github, reads };
  }

  const turn = (startedBy?: number) =>
    ({ kind: "agent-run-finished", role: "design", issue: 7, output: "{}", ...(startedBy === undefined ? {} : { startedBy }) }) as const;

  it("finds the reply still there", async () => {
    const { github, reads } = githubWhere(() => ({ id: 7003 }));

    const snapshot = await gatherSnapshot(github, repo, turn(7003), null, null);

    expect(snapshot.startingComment).toEqual({ id: 7003, exists: true });
    expect(reads).toEqual(["GET /repos/acme/shop/issues/comments/7003"]);
  });

  it("finds the reply gone when GitHub no longer has it", async () => {
    const { github } = githubWhere((options) => {
      expect(options.allowNotFound).toBe(true);
      return null;
    });

    const snapshot = await gatherSnapshot(github, repo, turn(7003), null, null);

    expect(snapshot.startingComment).toEqual({ id: 7003, exists: false });
  });

  it("fails, rather than calling the reply deleted, when the read itself fails", async () => {
    const { github } = githubWhere(() => {
      throw new Error("GitHub GET /repos/acme/shop/issues/comments/7003 failed: 502");
    });

    await expect(gatherSnapshot(github, repo, turn(7003), null, null)).rejects.toThrow("502");
  });

  it("reads no reply for a turn adding needs-design started", async () => {
    const { github, reads } = githubWhere(() => ({ id: 1 }));

    const snapshot = await gatherSnapshot(github, repo, turn(), null, null);

    expect(snapshot.startingComment).toBeNull();
    expect(reads).toEqual([]);
  });

  // A prototype turn is started by agent:design, so the reply it answers is the one that approved its request (#155).
  const prototypeTurn = (reply: number | null) =>
    ({
      kind: "prototype-run-finished",
      issue: 7,
      output: "{}",
      request: { request: { route: "/book", variants: 3, brief: "Three ways." }, reply },
      branch: "prototype/7",
      changes: { net: [], commits: [] },
      headSha: null,
      gallery: null,
      runUrl: "https://github.com/acme/shop/actions/runs/9100/attempts/1",
      repoUrl: "https://github.com/acme/shop",
    }) as const;

  it("reads whether a prototype turn's approving reply, which its request names, is still there", async () => {
    const { github, reads } = githubWhere(() => null);

    const snapshot = await gatherSnapshot(github, repo, prototypeTurn(9001), null, "fabrik-app[bot]");

    expect(snapshot.startingComment).toEqual({ id: 9001, exists: false });
    expect(reads).toEqual(["GET /repos/acme/shop/issues/comments/9001"]);
  });

  it("reads no reply for a prototype turn whose request agent:design started, which names none", async () => {
    const { github, reads } = githubWhere(() => ({ id: 1 }));

    const snapshot = await gatherSnapshot(github, repo, prototypeTurn(null), null, "fabrik-app[bot]");

    expect(snapshot.startingComment).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("Reading the Kit config folder through the API", () => {
  it("reads the Skills sources lockfile beside config.json and each role's instructions, the Auditor's too, at the ref", async () => {
    const files: Record<string, string> = {
      ".fabrik/config.json": `{ "roles": { "review": { "skills": ["jrey8343/skills/event-storming"] } } }`,
      ".fabrik/skills.lock.json": `[{ "repository": "jrey8343/skills", "sha": "${"a".repeat(40)}" }]`,
      ".fabrik/review.md": "Check the deciders.\n",
      ".fabrik/audit.md": "Booking first.\n",
    };
    const github = {
      async fileText(at: typeof repo, path: string, ref: string): Promise<string | null> {
        expect([at, ref]).toEqual([repo, "abc123"]);
        return files[path] ?? null;
      },
    };

    const sources = await readKitConfigSources(github, repo, "abc123");

    expect(sources.skillsLock).toBe(files[".fabrik/skills.lock.json"]);
    const result = resolveKitConfig(sources);
    expect(result.ok && result.config.extraSkills.review).toEqual([{ source: "jrey8343/skills", name: "event-storming" }]);
    expect(result.ok && result.config.instructions.review).toBe("Check the deciders.\n");
    expect(result.ok && result.config.instructions.audit).toBe("Booking first.\n");
  });

  it("gives no lockfile when the Product repo has none", async () => {
    const sources = await readKitConfigSources({ fileText: async () => null }, repo, "abc123");

    expect(sources.skillsLock).toBeNull();
  });
});

describe("Gathering the Kit-owned issues, whose markers steer agent runs (ADR-0007)", () => {
  const PERSON = { login: "mallory", __typename: "User" };
  const OTHER_BOT = { login: "other-app", __typename: "Bot" };
  const tick = { kind: "scheduled-tick", now: "2026-11-08T04:00:00.000Z" } as const;
  const heldMarker = (issue: number) => `<!-- fabrik:held ${JSON.stringify({ issue, role: "implement", label: "agent:implement" })} -->`;
  type Author = { login: string; __typename: string } | null;
  interface Comment {
    body: string;
    author: Author;
  }

  /**
   * The read-only API, holding one weekly-limit issue opened by `author` with
   * these comments, which it serves 100 at a time, newest page first, as
   * GitHub's `comments(last:, before:)` does.
   */
  function githubWith(author: Author, comments: readonly Comment[]) {
    const asked: number[] = [];
    const page = (before: number) => {
      const start = Math.max(0, before - 100);
      return {
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
        nodes: comments.slice(start, before),
      };
    };
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("issueOrPullRequest")) {
          const numbers = Object.entries(variables).filter(([name]) => /^n\d+$/.test(name)).map(([, value]) => value as number);
          asked.push(...numbers);
          return { repository: {} };
        }
        if (query.includes("defaultBranchRef")) return { repository: { defaultBranchRef: null, issues: { nodes: [] } } };
        if (query.includes("before: $before")) {
          return { repository: { issue: { comments: page(Number(variables["before"])) } } };
        }
        const retro = nothingNewForTheRetro(query);
        if (retro !== undefined) return retro;
        const ready = noReadyTicket(query);
        if (ready !== undefined) return ready;
        return {
          repository: {
            owner: { login: "acme" },
            issues: {
              nodes: [
                {
                  number: 41,
                  body: "@jrey The weekly usage limit is reached.\n\n<!-- fabrik:notified -->",
                  author,
                  labels: { nodes: [{ name: "fabrik:weekly-limit" }] },
                  comments: page(comments.length),
                },
              ],
            },
          },
        };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  it("reads only the App's own comments, so a held marker someone else posts holds no run", async () => {
    const { github, asked } = githubWith(APP, [
      { body: heldMarker(7), author: APP },
      { body: heldMarker(8), author: PERSON },
      { body: heldMarker(9), author: OTHER_BOT },
      { body: heldMarker(10), author: null },
    ]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues.map((issue) => issue.comments)).toEqual([[heldMarker(7)]]);
    expect(asked).toEqual([7]);
  });

  it("reads no body from a Kit-labelled issue the App didn't open", async () => {
    const { github } = githubWith(PERSON, []);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues).toEqual([{ number: 41, labels: ["fabrik:weekly-limit"], body: "", comments: [] }]);
  });

  it("reads every comment, however many there are, so the oldest held markers aren't cut off", async () => {
    const comments = Array.from({ length: 250 }, (_, at) => ({ body: heldMarker(at + 1), author: APP }));
    const { github } = githubWith(APP, comments);

    const snapshot = await gatherSnapshot(github, repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues[0]?.comments).toEqual(comments.map((comment) => comment.body));
  });

  /**
   * The read-only API, holding `open` Kit-owned weekly-limit issues, #1 the
   * oldest, which it serves `first` at a time after the cursor, as GitHub's
   * `issues(first:, after:)` does. Its `totalCount` is `open`.
   */
  function githubHolding(open: number) {
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("issueOrPullRequest")) return { repository: {} };
        if (query.includes("defaultBranchRef")) return { repository: { defaultBranchRef: null, issues: { nodes: [] } } };
        const retro = nothingNewForTheRetro(query);
        if (retro !== undefined) return retro;
        const first = Number(/issues\(states: OPEN, labels: \$labels, first: (\d+)/.exec(query)?.[1]);
        const start = typeof variables["after"] === "string" ? Number(variables["after"]) : 0;
        const end = Math.min(open, start + first);
        const nodes = Array.from({ length: end - start }, (_, at) => ({
          number: start + at + 1,
          body: "",
          author: APP,
          labels: { nodes: [{ name: "fabrik:weekly-limit" }] },
          comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
        }));
        return {
          repository: {
            owner: { login: "acme" },
            issues: { totalCount: open, pageInfo: { hasNextPage: end < open, endCursor: String(end) }, nodes },
          },
        };
      },
    } as unknown as GitHub;
    return github;
  }

  it("reads every open Kit-owned issue, page after page, so the 21st, the newest, isn't cut off (#441)", async () => {
    const snapshot = await gatherSnapshot(githubHolding(21), repo, tick, null, "fabrik-app[bot]");

    expect(snapshot.kitIssues.map(({ number }) => number)).toEqual(Array.from({ length: 21 }, (_, at) => at + 1));
  });

  it("fails, naming how many are open, rather than act on some of them when more are open than it reads (#441)", async () => {
    await expect(gatherSnapshot(githubHolding(250), repo, tick, null, "fabrik-app[bot]")).rejects.toThrow(/250 open issues/);
  });
});

describe("Gathering a scheduled tick's replay slice (#156)", () => {
  const tick = { kind: "scheduled-tick", now: "2026-11-11T04:00:00.000Z" } as const;
  const OPERATOR = { login: "jrey8343", __typename: "User" };

  /** An open issue node with these labels, as the Kit-issue and replay-issue queries answer for it. */
  function anIssueNode(number: number, labels: readonly string[], overrides: Record<string, unknown> = {}) {
    return {
      number,
      body: "",
      author: OPERATOR,
      labels: { nodes: labels.map((name) => ({ name })) },
      comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
      timelineItems: { nodes: [] },
      ...overrides,
    };
  }

  /**
   * The read-only API, holding these open Kit-owned issues and these open
   * replay issues, the ready Ticket #31 and no research Decision. The
   * queries it was asked are in `asked`.
   */
  function githubWith(kitIssues: unknown[], replayIssues: unknown[] = kitIssues) {
    const asked: string[] = [];
    const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    const github = {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        asked.push(query);
        if (query.includes("$replay")) return { repository: { issues: { nodes: replayIssues } } };
        if (query.includes("$ready")) {
          const ticket = { number: 31, state: "OPEN", labels: { nodes: [{ name: "ready-for-agent" }] }, subIssues: { totalCount: 0 }, blockedBy: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, comments: { nodes: [] } };
          return { repository: { owner: { login: "acme" }, issues: { ...none, nodes: [ticket] }, pullRequests: { nodes: [] } } };
        }
        if (query.includes("$research")) return { repository: { issues: none } };
        if (query.includes("issueOrPullRequest")) return { repository: {} };
        if (query.includes("labels: [$label]")) return { repository: { defaultBranchRef: null, issues: { nodes: [] } } };
        const retro = nothingNewForTheRetro(query);
        if (retro !== undefined) return retro;
        if (query.includes("$labels")) return { repository: { owner: { login: "acme" }, issues: { nodes: kitIssues } } };
        throw new Error(`Unexpected query with ${JSON.stringify(variables)}: ${query}`);
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  /** The store's Run records, counting each time they're read. */
  function storeHolding(records: readonly RunRecord[] | null) {
    const store = { reads: 0, records: async () => (store.reads++, records) };
    return store;
  }

  it("isn't gathered without the store's records, which only the Loop's own run passes, never the Kit job", async () => {
    const snapshot = await gatherSnapshot(githubWith([]).github, repo, tick, "jrey8343", "fabrik-app[bot]");

    expect(snapshot.replay).toBeNull();
  });

  it("reads nothing new with no replay issue open: no replay issue, Ticket or store read", async () => {
    const without = githubWith([anIssueNode(41, ["fabrik:weekly-limit"])]);
    await gatherSnapshot(without.github, repo, tick, "jrey8343", "fabrik-app[bot]");
    const { github, asked } = githubWith([anIssueNode(41, ["fabrik:weekly-limit"])]);
    const store = storeHolding([]);

    const snapshot = await gatherSnapshot(github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, store);

    expect(snapshot.replay).toEqual({ issues: [], capacity: null, acceptance: null });
    expect(asked).toEqual(without.asked);
    expect(store.reads).toBe(0);
  });

  it("reads no replay issue when none is among twenty or more open Kit-owned issues, since it reads every one of them (#441)", async () => {
    const many = Array.from({ length: 20 }, (_, at) => anIssueNode(41 + at, ["fabrik:audit"]));
    const { github, asked } = githubWith(many, [anIssueNode(140, ["fabrik:replay"], { body: acceptedBody() })]);

    const snapshot = await gatherSnapshot(github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, storeHolding([]));

    expect(snapshot.replay).toEqual({ issues: [], capacity: null, acceptance: null });
    expect(asked.some((query) => query.includes("$replay"))).toBe(false);
  });

  describe("with a replay issue open", () => {
    const replayNode = anIssueNode(140, ["fabrik:replay", "agent:replay"], {
      body: acceptedBody(),
      comments: {
        pageInfo: { hasPreviousPage: false, startCursor: null },
        nodes: [
          { body: "This replay can't run.", author: APP_BOT },
          { body: "Go on then.", author: OPERATOR },
        ],
      },
    });
    const someoneElses = anIssueNode(150, ["fabrik:replay"], { body: "```replay\nreview.effort: low\n```", author: { login: "mallory", __typename: "User" } });

    it("holds each one with its body whole, though the Operator filed it, the App's comments only, and its labels", async () => {
      const { github } = githubWith([replayNode, someoneElses]);

      const snapshot = await gatherSnapshot(github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, storeHolding([]));

      expect(snapshot.replay?.issues).toEqual([
        { number: 140, open: true, author: "jrey8343", body: acceptedBody(), comments: ["This replay can't run."], labels: ["fabrik:replay", "agent:replay"], gaveUp: false },
        { number: 150, open: true, author: "mallory", body: "```replay\nreview.effort: low\n```", comments: [], labels: ["fabrik:replay"], gaveUp: false },
      ]);
    });

    it("holds whether the Kit gave up on agent:replay there with nobody adding it since (#419), from the App's give-up comment alone", async () => {
      const gaveUp = "<!-- fabrik:stuck-trigger-gave-up agent:replay -->\n@jrey8343 `agent:replay` came off";
      const at = (createdAt: string) => ({ createdAt, label: { name: "agent:replay" } });
      const timeline = (...nodes: unknown[]) => ({ timelineItems: { nodes } });
      const { github } = githubWith([
        anIssueNode(140, ["fabrik:replay"], { body: acceptedBody(), ...timeline({ __typename: "LabeledEvent", ...at("2026-11-08T03:00:00Z") }, { __typename: "UnlabeledEvent", ...at("2026-11-08T05:00:00Z") }, { __typename: "IssueComment", body: gaveUp, author: APP_BOT }) }),
        anIssueNode(141, ["fabrik:replay"], { body: acceptedBody(), ...timeline({ __typename: "IssueComment", body: gaveUp, author: APP_BOT }, { __typename: "LabeledEvent", ...at("2026-11-08T06:00:00Z") }) }),
        anIssueNode(142, ["fabrik:replay"], { body: acceptedBody(), ...timeline({ __typename: "IssueComment", body: gaveUp, author: OPERATOR }) }),
      ]);

      const snapshot = await gatherSnapshot(github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, storeHolding([]));

      expect(snapshot.replay?.issues.map(({ number, gaveUp }) => [number, gaveUp])).toEqual([
        [140, true],
        [141, false],
        [142, false],
      ]);
    });

    it("holds what the spare-capacity gate weighs: what Dispatch weighs, and each Subscription's newest weekly-limit reading in the store", async () => {
      const records = [aRunRecord({ repo: "acme/clinic", endedAt: "2026-11-10T10:00:00Z", rateLimit: aReading(0.3) })];

      const snapshot = await gatherSnapshot(githubWith([replayNode]).github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, storeHolding(records));

      expect(snapshot.replay?.capacity).toEqual({
        tickets: [{ number: 31, open: true, labels: ["ready-for-agent"], openBlockers: [], notPlannedBlockers: [], subIssues: 0, openLinkedPullRequests: [], mergedLinkedPullRequests: [], lastRunFailed: false }],
        researchDecisions: [],
        weeklyLimits: { "Claude token": aReading(0.3) },
      });
      expect(snapshot.replay?.acceptance).toBeNull();
    });

    it("holds no reading when the store can't be read", async () => {
      const snapshot = await gatherSnapshot(githubWith([replayNode]).github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, storeHolding(null));

      expect(snapshot.replay?.capacity?.weeklyLimits).toBeNull();
    });

    it("reads nothing more when only someone else's replay issue is open", async () => {
      const store = storeHolding([]);

      const snapshot = await gatherSnapshot(githubWith([someoneElses]).github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, store);

      expect(snapshot.replay).toMatchObject({ capacity: null, acceptance: null });
      expect(store.reads).toBe(0);
    });

    it("reads a waiting request's candidates from this repo's records alone, with none to read GitHub for when it has no Implement run there", async () => {
      const waiting = anIssueNode(140, ["fabrik:replay"], { body: "```replay\nreview.effort: high\n```\n" });
      const records = [aRunRecord({ repo: "acme/clinic", issue: 12, endedAt: "2026-11-10T10:00:00Z" })];
      const { github, asked } = githubWith([waiting]);

      const snapshot = await gatherSnapshot(github, repo, tick, "jrey8343", "fabrik-app[bot]", null, null, storeHolding(records));

      expect(snapshot.replay?.acceptance).toEqual({ candidates: [], baseConfigs: {}, fabrikCommits: {} });
      expect(asked.some((query) => query.includes("mergedAt"))).toBe(false);
    });
  });
});

describe("Gathering a replay Ticket's claim (#156)", () => {
  const claim = { kind: "label-added", issue: 98, label: "agent:replay" } as const;

  /** The issue API, holding these open replay issues beside the labelled one, #98. */
  function githubHolding(replayIssues: unknown[]): GitHub {
    const issues = issueGitHub({ author: { login: "jrey8343", __typename: "User" }, labels: ["fabrik:replay", "agent:replay"] });
    return {
      async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
        if (query.includes("$replay")) return { repository: { issues: { nodes: replayIssues } } };
        return issues.graphql(query, variables);
      },
    } as unknown as GitHub;
  }

  it("reads every open replay issue, with its body whole, so the claim can start none while a Ticket of any is in progress", async () => {
    const other = {
      number: 130,
      body: acceptedBody([20], [{ ticket: 20, state: "in-progress", run: 8000, retrying: null, startedAt: "2026-11-11T03:00:00.000Z" }]),
      author: { login: "jrey8343", __typename: "User" },
      labels: { nodes: [{ name: "fabrik:replay" }] },
      comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
      timelineItems: { nodes: [] },
    };

    const snapshot = await gatherSnapshot(githubHolding([other]), repo, claim, "jrey8343", APP_LOGIN);

    expect(snapshot.replay).toEqual({
      issues: [{ number: 130, open: true, author: "jrey8343", body: other.body, comments: [], labels: ["fabrik:replay"], gaveUp: false }],
      capacity: null,
      acceptance: null,
    });
  });

  it("reads none for any other label", async () => {
    const snapshot = await gatherSnapshot(githubHolding([]), repo, { ...claim, label: "agent:implement" }, "jrey8343", APP_LOGIN);

    expect(snapshot.replay).toBeNull();
  });
});

describe("Gathering the open agent PRs the conflict check weighs (#304)", () => {
  const MAIN = "9".repeat(40);
  const node = (number: number, mergeable: string, overrides: Record<string, unknown> = {}) => ({
    number,
    state: "OPEN",
    isDraft: false,
    headRefName: `fabrik/ticket-${number - 43}`,
    headRefOid: HEAD_SHA,
    author: APP_BOT,
    body: "",
    labels: { nodes: [] },
    url: `https://github.com/acme/shop/pull/${number}`,
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{ body: `<!-- fabrik:conflict-attempt ${"8".repeat(40)} rebased -->\nRebased.`, createdAt: "2026-01-01T00:00:00Z", author: { __typename: "Bot" } }],
    },
    changesRequests: { nodes: [] },
    draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    createdAt: "2025-12-01T00:00:00Z",
    forcePushes: { nodes: [] },
    commits: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    closingIssuesReferences: { nodes: [] },
    mergeable,
    ...overrides,
  });

  /** A GitHub whose open PRs read as each of `reads` in turn, the last one from then on; it counts the waits between reads. */
  function githubReading(reads: unknown[][]) {
    let read = 0;
    const waits: number[] = [];
    const github = {
      [ANSWERS_CONFLICTS]: true,
      async graphql(query: string) {
        if (isConflictsQuery(query)) {
          const nodes = reads[Math.min(read, reads.length - 1)];
          read += 1;
          return { repository: { defaultBranchRef: { target: { oid: "d".repeat(40) } }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
        }
        // Every other slice a tick reads finds nothing.
        const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
        return { repository: { owner: { login: "acme" }, defaultBranchRef: null, issues: none, pullRequests: none } };
      },
    } as unknown as GitHub;
    const wait = async (ms: number) => void waits.push(ms);
    return { github, waits, wait, reads: () => read };
  }

  it("holds main's head as GitHub reads it with the PRs' mergeable state, not the push's own, which may be stale once checks take turns, and every open agent PR with the Kit's attempts on it", async () => {
    const { github } = githubReading([[node(50, "CONFLICTING"), node(51, "MERGEABLE"), node(60, "CONFLICTING", { headRefName: "feature", author: { login: "jrey", __typename: "User" } })]]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN);

    expect(snapshot.conflicts?.main).toBe("d".repeat(40));
    expect(snapshot.conflicts?.pullRequests.map(({ pullRequest, mergeable }) => [pullRequest.number, mergeable])).toEqual([
      [50, false],
      [51, true],
    ]);
    expect(snapshot.conflicts?.pullRequests[0]?.pullRequest).toMatchObject({ draft: false, ticket: 7, conflictAttempts: ["8".repeat(40)], conflictRunInFlight: null });
  });

  describe("when each PR's head was pushed (#389)", () => {
    const kit = (body: string, createdAt: string) => ({ body, createdAt, author: { __typename: "Bot" } });
    const pushedAt = async (overrides: Record<string, unknown>) => {
      const { github } = githubReading([[node(50, "CONFLICTING", { createdAt: "2026-01-01T00:00:00Z", comments: { pageInfo: { hasPreviousPage: false }, nodes: [] }, ...overrides })]]);
      return (await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN)).conflicts?.pullRequests[0]?.pullRequest.headPushedAt;
    };

    it("is when the Fabrik App opened it, while nothing since says it was pushed again", async () => {
      expect(await pushedAt({})).toBe("2026-01-01T00:00:00Z");
    });

    it("is the latest force push of its branch, as the timeline shows it", async () => {
      const forcePushes = { nodes: [{ createdAt: "2026-01-02T00:00:00Z" }, { createdAt: "2026-01-03T00:00:00Z" }] };

      expect(await pushedAt({ forcePushes })).toBe("2026-01-03T00:00:00Z");
    });

    it("falls back to the Kit's latest note of its own push, a person's quoting one counting for nothing", async () => {
      const comments = {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          kit("<!-- fabrik:retry-push -->\nThe Implementer pushed a fix.", "2026-01-04T00:00:00Z"),
          kit("<!-- fabrik:request-changes-run -->\nThe Implementer pushed the Operator's requested changes.", "2026-01-05T00:00:00Z"),
          kit("A comment that records no push.", "2026-01-07T00:00:00Z"),
          { body: "<!-- fabrik:retry-push -->\nQuoted.", createdAt: "2026-01-08T00:00:00Z", author: { __typename: "User" } },
        ],
      };

      expect(await pushedAt({ comments })).toBe("2026-01-05T00:00:00Z");
    });

    it("is no earlier than its head commit's commit time, as for a push of the Operator's that GitHub records no event for", async () => {
      const commits = { pageInfo: { hasPreviousPage: false }, nodes: [{ commit: { oid: HEAD_SHA, committedDate: "2026-01-06T00:00:00Z" } }] };

      expect(await pushedAt({ commits })).toBe("2026-01-06T00:00:00Z");
      expect(await pushedAt({ commits: { pageInfo: { hasPreviousPage: false }, nodes: [{ commit: { oid: "b".repeat(40), committedDate: "2026-01-06T00:00:00Z" } }] } })).toBe("2026-01-01T00:00:00Z");
    });
  });

  it("holds the default branch's head on a scheduled tick, which names none", async () => {
    const { github } = githubReading([[]]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "scheduled-tick", now: "2026-11-07T10:17:00Z" }, null, APP_LOGIN);

    expect(snapshot.conflicts).toEqual({ main: "d".repeat(40), now: "2026-11-07T10:17:00Z", implementJobUnderWay: null, pullRequests: [] });
  });

  it("reads again while GitHub is still working out whether a PR conflicts, until it knows", async () => {
    const { github, waits, wait } = githubReading([[node(50, "UNKNOWN")], [node(50, "UNKNOWN")], [node(50, "CONFLICTING")]]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN, null, null, null, wait);

    expect(snapshot.conflicts?.pullRequests[0]?.mergeable).toBe(false);
    expect(waits).toEqual([MERGEABLE_WAIT_MS, MERGEABLE_WAIT_MS]);
  });

  it("stops after a bounded number of reads, leaving a PR still unknown as unknown, for the scheduled tick", async () => {
    const { github, waits, wait, reads } = githubReading([[node(50, "UNKNOWN")]]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN, null, null, null, wait);

    expect(snapshot.conflicts?.pullRequests[0]?.mergeable).toBeNull();
    expect(reads()).toBe(MERGEABLE_READS);
    expect(waits).toHaveLength(MERGEABLE_READS - 1);
  });

  // #387: what the conflict check weighs before restarting a stalled Request-changes run on a draft.
  it.each([
    ["running", [{ name: "fabrik / Implement", status: "in_progress" }]],
    ["queued behind its concurrency group", [{ name: "fabrik / Implement", status: "queued" }]],
    ["done, with its push job still to land it", [{ name: "fabrik / Implement", status: "completed", conclusion: "success" }, { name: "fabrik / Push", status: "in_progress" }]],
  ])("reads an Implement job under way when one is %s", async (_, jobs) => {
    const { github } = githubReading([[]]);
    const actions = actionsWith([{ id: 1, status: "in_progress", jobs }]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.conflicts?.implementJobUnderWay).toBe(true);
  });

  it("reads no Implement job under way when the only unfinished runs skipped theirs or have landed theirs, and finished runs don't count", async () => {
    const { github } = githubReading([[]]);
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed", conclusion: "skipped" }, { name: "fabrik / Push", status: "in_progress" }] },
      { id: 2, status: "completed", jobs: [{ name: "fabrik / Implement", status: "in_progress" }] },
      // #432: as Dispatch reads it, the push job landing the run ends the Implement job's hold.
      { id: 3, status: "in_progress", jobs: [{ name: "fabrik / Implement", status: "completed", conclusion: "success" }, { name: "fabrik / Push", status: "completed", conclusion: "success" }, { name: "fabrik / Score", status: "in_progress" }] },
    ]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "scheduled-tick", now: "2026-11-07T10:17:00Z" }, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.conflicts?.implementJobUnderWay).toBe(false);
  });

  it("reads whether an Implement job is under way as unknown when the Actions API fails, and still holds every PR", async () => {
    const { github } = githubReading([[node(50, "CONFLICTING")]]);
    const actions = { rest: async () => Promise.reject(new Error("GitHub GET actions/runs failed: 403 API rate limit exceeded")) };

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.conflicts?.implementJobUnderWay).toBeNull();
    expect(snapshot.conflicts?.pullRequests.map(({ pullRequest }) => pullRequest.number)).toEqual([50]);
  });

  it("reads whether an Implement job is under way as unknown without a token that can read workflow runs", async () => {
    const { github } = githubReading([[]]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN);

    expect(snapshot.conflicts?.implementJobUnderWay).toBeNull();
  });

  it("isn't gathered for any other event", async () => {
    const { github, reads } = githubReading([[node(50, "CONFLICTING")]]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "dispatch-check" }, null, APP_LOGIN).catch(() => null);

    expect(snapshot?.conflicts ?? null).toBeNull();
    expect(reads()).toBe(0);
  });

  it("pages past the first open PRs, so an agent PR behind others' isn't missed (#341)", async () => {
    const afters: unknown[] = [];
    const github = {
      [ANSWERS_CONFLICTS]: true,
      async graphql(query: string, variables: { after?: unknown }) {
        if (isConflictsQuery(query)) {
          afters.push(variables.after);
          const page =
            variables.after === null
              ? { pageInfo: { hasNextPage: true, endCursor: "cursor-1" }, nodes: [node(60, "CONFLICTING", { headRefName: "feature", author: { login: "jrey", __typename: "User" } })] }
              : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(50, "CONFLICTING")] };
          return { repository: { defaultBranchRef: { target: { oid: "d".repeat(40) } }, pullRequests: page } };
        }
        const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
        return { repository: { owner: { login: "acme" }, defaultBranchRef: null, issues: none, pullRequests: none } };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN);

    expect(afters).toEqual([null, "cursor-1"]);
    expect(snapshot.conflicts?.pullRequests.map(({ pullRequest }) => pullRequest.number)).toEqual([50]);
    expect(snapshot.conflicts?.pullRequests[0]?.pullRequest.url).toBe("https://github.com/acme/shop/pull/50");
  });

  it("reads the Operator's Request changes no run has built, leaving out one from before the comments it read when there were more (#341)", async () => {
    const operator = { login: "jrey", __typename: "User" };
    const review = (databaseId: number, submittedAt: string) => ({ databaseId, submittedAt, author: operator });
    const read = (hasPreviousPage: boolean) =>
      node(50, "CONFLICTING", {
        comments: { pageInfo: { hasPreviousPage }, nodes: [{ body: "Looks close.", createdAt: "2026-11-07T05:00:00Z", author: { __typename: "User" } }] },
        changesRequests: { nodes: [review(101, "2026-11-07T04:00:00Z"), review(102, "2026-11-07T05:30:00Z")] },
        // It left draft for the Merge gate before either review.
        draftEvents: { pageInfo: { hasPreviousPage: false }, nodes: [{ __typename: "ReadyForReviewEvent", createdAt: "2026-11-07T03:00:00Z" }] },
      });

    const all = await gatherSnapshot(githubReading([[read(false)]]).github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN);
    const cut = await gatherSnapshot(githubReading([[read(true)]]).github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN);

    const unbuilt = (snapshot: typeof all) => snapshot.conflicts?.pullRequests[0]?.pullRequest.unbuiltChangesRequests.map(({ review: id }) => id);
    expect(unbuilt(all)).toEqual([101, 102]);
    // What settled 101 may be among the comments before the 100 it read.
    expect(unbuilt(cut)).toEqual([102]);
  });

  it("reads an agent PR's earlier comments, a page at a time, so a long thread still shows what its Request changes are (#341)", async () => {
    const operator = { login: "jrey", __typename: "User" };
    const bot = { __typename: "Bot" };
    const started = { body: "<!-- fabrik:request-changes-run-started 101 -->\nThe Kit is starting the Request-changes run.", createdAt: "2026-11-07T04:01:00Z", author: bot };
    const latest = node(50, "CONFLICTING", {
      comments: { pageInfo: { hasPreviousPage: true, startCursor: "c-100" }, nodes: [{ body: "Looks close.", createdAt: "2026-11-07T05:00:00Z", author: { __typename: "User" } }] },
      changesRequests: { nodes: [{ databaseId: 101, submittedAt: "2026-11-07T04:00:00Z", author: operator }] },
      draftEvents: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          { __typename: "ReadyForReviewEvent", createdAt: "2026-11-07T03:00:00Z" },
          { __typename: "ConvertToDraftEvent", createdAt: "2026-11-07T04:01:00Z" },
        ],
      },
      isDraft: true,
    });
    const befores: unknown[] = [];
    const github = {
      [ANSWERS_CONFLICTS]: true,
      async graphql(query: string, variables: Record<string, unknown>) {
        if (isConflictsQuery(query)) {
          return { repository: { defaultBranchRef: { target: { oid: "d".repeat(40) } }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [latest] } } };
        }
        if (query.includes("pullRequest(number: $number)") && "before" in variables) {
          befores.push(variables["before"]);
          // The Kit's note that started the run for 101 is among the earlier comments.
          return { repository: { pullRequest: { comments: { pageInfo: { hasPreviousPage: false, startCursor: "c-0" }, nodes: [started] } } } };
        }
        const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
        return { repository: { owner: { login: "acme" }, defaultBranchRef: null, issues: none, pullRequests: none } };
      },
    } as unknown as GitHub;

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: MAIN }, null, APP_LOGIN);

    expect(befores).toEqual(["c-100"]);
    expect(snapshot.conflicts?.pullRequests[0]?.pullRequest).toMatchObject({
      unbuiltChangesRequests: [{ review: 101 }],
      notedChangesRequests: [101],
      requestChangesRunInFlight: 101,
    });
  });

  it("counts the Operator's own Request changes on the draft while their run works, and no one else's (#341)", async () => {
    const bot = { __typename: "Bot" };
    const review = (databaseId: number, submittedAt: string, login: string) => ({ databaseId, submittedAt, author: { login, __typename: "User" } });
    const pullRequest = node(50, "CONFLICTING", {
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [{ body: "<!-- fabrik:request-changes-run-started 101 -->\nStarting.", createdAt: "2026-11-07T04:01:00Z", author: bot }],
      },
      changesRequests: {
        nodes: [review(101, "2026-11-07T04:00:00Z", "jrey"), review(102, "2026-11-07T04:30:00Z", "jrey"), review(103, "2026-11-07T04:31:00Z", "teammate")],
      },
      draftEvents: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          { __typename: "ReadyForReviewEvent", createdAt: "2026-11-07T03:00:00Z" },
          { __typename: "ConvertToDraftEvent", createdAt: "2026-11-07T04:01:00Z" },
        ],
      },
      isDraft: true,
    });

    const snapshot = await gatherSnapshot(githubReading([[pullRequest]]).github, repo, { kind: "main-pushed", head: MAIN }, "jrey", APP_LOGIN);

    expect(snapshot.conflicts?.pullRequests[0]?.pullRequest).toMatchObject({
      unbuiltChangesRequests: [{ review: 101 }, { review: 102 }],
      notedChangesRequests: [101, 102],
      requestChangesRunInFlight: 101,
      requestChangesRunReviews: [101],
    });
  });
});

describe("Gathering whether a Reviewer's Verdict's PR merges cleanly (#480)", () => {
  const reviewed: LoopEvent = {
    kind: "review-run-finished",
    pullRequest: 50,
    headSha: HEAD_SHA,
    output: "verdict: pass",
    runUrl: "https://github.com/acme/shop/actions/runs/42/attempts/1",
    repoUrl: "https://github.com/acme/shop",
  };

  /** The PR GitHub has for the Verdict, whose mergeable state reads as each of `reads` in turn, the last one from then on. */
  function githubReading(reads: string[]) {
    let read = 0;
    const pullRequests = pullRequestGitHub();
    const github = {
      async graphql(query: string, variables: Record<string, unknown>) {
        if (!/\bmergeable\b/.test(query)) return pullRequests.graphql(query, variables);
        expect(variables).toMatchObject({ owner: "acme", name: "shop", number: 50 });
        const mergeable = reads[Math.min(read, reads.length - 1)];
        read += 1;
        return { repository: { defaultBranchRef: { target: { oid: "d".repeat(40) } }, pullRequest: { mergeable } } };
      },
    } as unknown as GitHub;
    return { github, reads: () => read };
  }

  it.each([
    ["CONFLICTING", false],
    ["MERGEABLE", true],
  ])("reads %s as mergeable %s, against the default branch's head as GitHub reads it with it", async (state, mergeable) => {
    const snapshot = await gatherSnapshot(githubReading([state]).github, repo, reviewed, null, APP_LOGIN);

    expect(snapshot.mergeable).toEqual({ main: "d".repeat(40), mergeable });
    expect(snapshot.pullRequest?.number).toBe(50);
  });

  it("leaves it unknown after a bounded number of reads while GitHub is still working it out", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    const unknown = githubReading(["UNKNOWN"]);

    const snapshot = await gatherSnapshot(unknown.github, repo, reviewed, null, APP_LOGIN, null, null, null, wait);

    expect(snapshot.mergeable).toEqual({ main: "d".repeat(40), mergeable: null });
    expect(unknown.reads()).toBe(MERGEABLE_READS);
    expect(waits).toHaveLength(MERGEABLE_READS - 1);
  });

  it("reads again while GitHub is still working it out, until it knows", async () => {
    const snapshot = await gatherSnapshot(githubReading(["UNKNOWN", "CONFLICTING"]).github, repo, reviewed, null, APP_LOGIN);

    expect(snapshot.mergeable?.mergeable).toBe(false);
  });

  it("isn't read for any other PR event", async () => {
    const snapshot = await gatherSnapshot(githubReading(["CONFLICTING"]).github, repo, { kind: "pull-request-pushed", pullRequest: 50 }, null, APP_LOGIN);

    expect(snapshot.mergeable).toBeNull();
  });
});

describe("The names of the jobs a trigger label's run shows up as (#419)", () => {
  it.each([
    ["implement-claim", () => CLAIM_JOB_NAME],
    ["review-checks", () => REVIEW_CHECKS_JOB_NAME],
    // #477: followed by its agent PR, quoted since an unquoted ` #` starts a YAML comment.
    ["review", () => `"${REVIEW_JOB_NAME} PR #\${{ needs.kit.outputs.pull-request }}"`],
  ])("is the name loop.yml gives the %s job, which the stuck-trigger sweep reads a run behind a label by", async (job, name) => {
    const workflow = await readFile(new URL("../../.github/workflows/loop.yml", import.meta.url), "utf8");

    expect(new RegExp(`^ {2}${job}:\\n {4}name: (.+)$`, "m").exec(workflow)?.[1]).toBe(name());
  });
});

describe("Gathering a scheduled tick's trigger-sweep slice (#419)", () => {
  const tick = { kind: "scheduled-tick", now: "2026-11-09T04:00:00Z" } as const;
  const BOT = { login: "fabrik-app", __typename: "Bot" };
  const labeled = (name: string, createdAt: string) => ({ __typename: "LabeledEvent", createdAt, label: { name } });
  const unlabeled = (name: string, createdAt: string) => ({ __typename: "UnlabeledEvent", createdAt, label: { name } });
  const comment = (body: string, createdAt: string, author: unknown = BOT) => ({ __typename: "IssueComment", createdAt, body, author });
  const node = (number: number, labels: string[], timeline: unknown[]) => ({ number, labels: { nodes: labels.map((name) => ({ name })) }, timelineItems: { nodes: timeline } });

  /** The API, holding these open issues and PRs with a trigger label; every other slice a tick reads finds nothing. The sweep's queries are in `asked`. */
  function githubWith(issues: unknown[], pullRequests: unknown[] = []) {
    const asked: { query: string; variables: Record<string, unknown> }[] = [];
    const none = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    const github = {
      async graphql(query: string, variables: Record<string, unknown>) {
        if (query.includes("$triggers")) {
          asked.push({ query, variables });
          const nodes = query.includes("pullRequests(") ? pullRequests : issues;
          return { repository: { [query.includes("pullRequests(") ? "pullRequests" : "issues"]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
        }
        return { repository: { owner: { login: "acme" }, defaultBranchRef: null, issues: none, pullRequests: none } };
      },
    } as unknown as GitHub;
    return { github, asked };
  }

  it("reads each trigger label on an open issue or PR, when it was last added, and whether the Kit's re-add came after it last came off", async () => {
    const { github, asked } = githubWith(
      [
        node(7, ["ready-for-agent", "agent:implement"], [
          labeled("agent:implement", "2026-11-09T01:00:00Z"),
          unlabeled("agent:implement", "2026-11-09T02:00:00Z"),
          labeled("agent:implement", "2026-11-09T02:00:00Z"),
          // Same second as the cycle: timeline order, not time, says it came after.
          comment("<!-- fabrik:stuck-trigger-readded agent:implement -->\nsat", "2026-11-09T02:00:00Z"),
        ]),
        node(8, ["agent:research"], [
          comment("<!-- fabrik:stuck-trigger-readded agent:research -->\nsat", "2026-11-08T01:00:00Z"),
          unlabeled("agent:research", "2026-11-08T01:05:00Z"),
          labeled("agent:research", "2026-11-09T03:00:00Z"),
        ]),
        // Quoting the marker isn't the Kit's word.
        node(9, ["agent:design"], [labeled("agent:design", "2026-11-09T03:00:00Z"), comment("<!-- fabrik:stuck-trigger-readded agent:design -->", "2026-11-09T03:10:00Z", { login: "mallory", __typename: "User" })]),
      ],
      [node(50, ["agent:review"], [])],
    );
    const actions = actionsWith([]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.triggers?.labelled).toEqual([
      { number: 7, label: "agent:implement", lastAddedAt: "2026-11-09T02:00:00Z", readded: true },
      { number: 8, label: "agent:research", lastAddedAt: "2026-11-09T03:00:00Z", readded: false },
      { number: 9, label: "agent:design", lastAddedAt: "2026-11-09T03:00:00Z", readded: false },
      { number: 50, label: "agent:review", lastAddedAt: null, readded: false },
    ]);
    // Closed ones are never swept.
    expect(asked.map(({ query }) => /(issues|pullRequests)\(states: OPEN, labels: \$triggers/.exec(query)?.[1])).toEqual(["issues", "pullRequests"]);
    expect(asked[0]?.variables["triggers"]).toEqual(["agent:implement", "agent:design", "agent:review", "agent:research", "agent:replay"]);
  });

  it("reads which roles have a job under way in an unfinished run, called from a caller workflow or not, leaving out jobs their run skipped", async () => {
    const { github } = githubWith([]);
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Claim the work", status: "completed", conclusion: "success" }, { name: "fabrik / Implement", status: "completed", conclusion: "skipped" }, { name: "fabrik / Review", status: "queued" }] },
      { id: 2, status: "queued", jobs: [{ name: "Design-session turn #12", status: "queued" }, { name: "fabrik / Prototype turn #3", status: "queued" }] },
      { id: 3, status: "completed", jobs: [{ name: "fabrik / Research", status: "in_progress" }] },
    ]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.triggers?.underWay).toEqual({ implement: false, research: false, review: true, claim: true, designTurns: [3, 12] });
  });

  // #477: the Review job names its agent PR; a run of an earlier Kit release names none.
  it("reads a Review job named for its agent PR as Review under way, and an Implement job named for its Ticket as Implement", async () => {
    const { github } = githubWith([]);
    const actions = actionsWith([
      { id: 1, status: "in_progress", jobs: [{ name: "fabrik / Review PR #60", status: "in_progress" }] },
      { id: 2, status: "in_progress", jobs: [{ name: "fabrik / Implement #12 (Retry 2)", status: "queued" }] },
    ]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.triggers?.underWay).toMatchObject({ implement: true, review: true });
  });

  it("reads a Review checks job as Review under way", async () => {
    const { github } = githubWith([]);
    const actions = actionsWith([{ id: 1, status: "in_progress", jobs: [{ name: "fabrik / Review checks", status: "in_progress" }] }]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.triggers?.underWay).toMatchObject({ review: true });
  });

  it("reads nothing under way as unknown, and no label, when the Actions API fails", async () => {
    const { github, asked } = githubWith([node(7, ["agent:implement"], [])]);
    const actions = { rest: async () => Promise.reject(new Error("GitHub GET actions/runs failed: 403")) };

    const snapshot = await gatherSnapshot(github, repo, tick, null, APP_LOGIN, actions as unknown as GitHub);

    expect(snapshot.triggers).toEqual({ underWay: null, labelled: [] });
    expect(asked).toEqual([]);
  });

  it("reads it as unknown too without a token that can read workflow runs", async () => {
    const { github } = githubWith([node(7, ["agent:implement"], [])]);

    const snapshot = await gatherSnapshot(github, repo, tick, null, APP_LOGIN);

    expect(snapshot.triggers).toEqual({ underWay: null, labelled: [] });
  });

  it("isn't gathered for any other event", async () => {
    const { github } = githubWith([]);

    const snapshot = await gatherSnapshot(github, repo, { kind: "main-pushed", head: "d".repeat(40) }, null, APP_LOGIN, actionsWith([]) as unknown as GitHub);

    expect(snapshot.triggers).toBeNull();
  });
});

