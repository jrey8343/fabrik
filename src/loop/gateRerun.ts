// One more re-run at the Merge gate (#783, spec #774). One hourly Tick after a
// pass that names an Unrelated failure still red on the head it was given on,
// the Kit re-runs that check's failed jobs once more, so a check that clears
// by itself opens the Merge gate without the Operator. The Tick's job holds no
// `actions: write`, and the caller workflow doesn't change, so the Tick posts
// a quiet line whose marker records the head and the checks, and adds
// agent:rerun-checks; the Loop workflow routes that label to the Re-run red
// checks job, the one job that holds `actions: write` (ADR-0018), whose claim
// takes it off as the run starts and marks the line started. Later Ticks read
// what came of it from the head's check runs: green is a Flaky check, which
// the existing read of a passed head reports (src/loop/flakyChecks.ts); red
// again, a refusal, or a label with no run behind it is said once on the PR
// and counts as done. A check from an outside service, or one red on main's
// head, is skipped and counts as done. The Kit never tries twice on one head.
// Pure.
import { declineTrigger } from "./declineTrigger.ts";
import { checkCode, passedHeadAtGate } from "./flakyChecks.ts";
import { RERUN_CHECKS_LABEL } from "./labels.ts";
import { gateRerunDoneMarker, gateRerunMarker } from "./markers.ts";
import type { Action, GateRerunDone, GateRerunMark, HeadCheckRun, PassedHeadChecks, Plan, PullRequestSnapshot, Snapshot } from "./types.ts";

const RED = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

/** A GitHub Actions job's page: …/actions/runs/<run>/job/<job>. Any other check run is an outside service's. */
const ACTIONS_JOB = /\/actions\/runs\/\d+\/job\/\d+$/;

/** A check's latest run on a head: a run not yet started is the newest, as GitHub queued it after every run that has. */
function latestRun(checkRuns: readonly HeadCheckRun[], name: string): HeadCheckRun | undefined {
  const started = (run: HeadCheckRun) => (run.startedAt === null ? Infinity : Date.parse(run.startedAt));
  return checkRuns.filter((run) => run.name === name).toSorted((a, b) => started(a) - started(b)).at(-1);
}

function isRed(run: HeadCheckRun | undefined): run is HeadCheckRun {
  return run !== undefined && run.conclusion !== null && RED.includes(run.conclusion);
}

/** The checks a gate re-run line on this PR already names on this head, asked or done. */
function namedOn(pullRequest: PullRequestSnapshot, headSha: string): Set<string> {
  return new Set(
    pullRequest.gateReruns.filter((mark) => mark.headSha === headSha).flatMap((mark) => (mark.kind === "asked" ? mark.checks.map(({ name }) => name) : mark.checks)),
  );
}

/**
 * The Unrelated failures the latest pass on this PR's head names, at the
 * Merge gate, that are still red there and that no gate re-run line names on
 * that head yet: each with its latest, red, run. Empty for a PR not at the
 * gate, as when its head moved since the pass. The Tick reads main's head for
 * these alone (src/github/snapshot.ts).
 */
export function unrelatedToAsk(pullRequest: PullRequestSnapshot, checkRuns: readonly HeadCheckRun[]): { readonly name: string; readonly red: HeadCheckRun | null }[] {
  const headSha = passedHeadAtGate(pullRequest);
  if (headSha === null) return [];
  const pass = pullRequest.verdicts.findLast((record) => record.verdict === "pass");
  const named = namedOn(pullRequest, headSha);
  return (pass?.unrelated ?? []).flatMap((name): { name: string; red: HeadCheckRun | null }[] => {
    if (named.has(name)) return [];
    const runs = checkRuns.filter((run) => run.name === name);
    // A check with no check run on the head is a commit status: an outside service's, whatever it says now.
    if (runs.length === 0) return [{ name, red: null }];
    const latest = latestRun(checkRuns, name);
    return isRed(latest) ? [{ name, red: latest }] : [];
  });
}

/** `checks` as Markdown code, joined, and whether there's one or more. */
function named(checks: readonly string[]): { readonly names: string; readonly one: boolean } {
  return { names: checks.map(checkCode).join(", "), one: checks.length === 1 };
}

/** What each way of being done says, after the checks' names, as a clause; `short` is the head's. */
const DONE_WORDING: Readonly<Record<GateRerunDone, (one: boolean, short: string) => string>> = {
  outside: (one) =>
    `${one ? "isn't a GitHub Actions check" : "aren't GitHub Actions checks"}, so the Kit can't re-run ${one ? "it" : "them"} at the Merge gate: only the service that reports ${one ? "it" : "them"} can`,
  "red-on-main": (one) => `${one ? "is" : "are"} red on main's head too, so the Kit doesn't re-run ${one ? "it" : "them"} at the Merge gate, where a re-run can't help`,
  "red-again": (one, short) => `failed again when the Kit re-ran ${one ? "it" : "them"} once more on ${short}, so the pull request waits for ${one ? "its" : "their"} fix`,
  refused: (one, short) => `${one ? "wasn't" : "weren't"} re-run once more on ${short}: the Re-run red checks job started no run, as when GitHub refused it`,
  "no-run": (one, short) => `${one ? "wasn't" : "weren't"} re-run once more on ${short}: \`${RERUN_CHECKS_LABEL}\` sat on the pull request with no run behind it`,
};

/** One quiet line saying one more re-run at the Merge gate is done for `checks` on this head, and why: said once, it counts as done. */
function doneLine(pullRequest: number, headSha: string, checks: readonly string[], why: GateRerunDone): Action {
  const { names, one } = named(checks);
  return { kind: "comment", issue: pullRequest, body: `${gateRerunDoneMarker(headSha, checks, why)}\n${names} ${DONE_WORDING[why](one, headSha.slice(0, 7))}.` };
}

/**
 * The Tick's ask on one passed head: the line and the label for the checks it
 * can re-run, and one line recording as done each it skips, an outside
 * service's or one red on main's head.
 */
function askActions(pullRequest: PullRequestSnapshot, head: PassedHeadChecks): Action[] {
  const unrelated = unrelatedToAsk(pullRequest, head.checkRuns);
  const outside = unrelated.flatMap(({ name, red }) => (red === null || !ACTIONS_JOB.test(red.url) ? [name] : []));
  // main's head unread says nothing is red there: a re-run is cheap.
  const onMain = head.redOnMain === undefined || head.redOnMain === "unread" ? [] : head.redOnMain;
  const redOnMain = unrelated.flatMap(({ name }) => (!outside.includes(name) && onMain.includes(name) ? [name] : []));
  const toAsk = unrelated.flatMap(({ name, red }) => (red === null || outside.includes(name) || redOnMain.includes(name) ? [] : [{ name, link: red.url }]));
  const skipped = [
    ...(outside.length === 0 ? [] : [doneLine(pullRequest.number, head.headSha, outside, "outside")]),
    ...(redOnMain.length === 0 ? [] : [doneLine(pullRequest.number, head.headSha, redOnMain, "red-on-main")]),
  ];
  if (toAsk.length === 0) return skipped;
  const { names, one } = named(toAsk.map(({ name }) => name));
  const short = head.headSha.slice(0, 7);
  return [
    ...skipped,
    {
      kind: "comment",
      issue: pullRequest.number,
      body:
        `${gateRerunMarker(head.headSha, toAsk)}\n` +
        `${names} ${one ? "is" : "are"} still red on ${short}, and the Reviewer judged ${one ? "it an Unrelated failure" : "them Unrelated failures"}, ` +
        `so the Kit is re-running ${one ? "its" : "their"} failed jobs once more through \`${RERUN_CHECKS_LABEL}\`.`,
    },
    { kind: "add-labels", issue: pullRequest.number, labels: [RERUN_CHECKS_LABEL] },
  ];
}

/**
 * How long an ask waits before the Tick reads it as come to nothing: the
 * Re-run red checks job takes a re-run up within minutes, and the Tick is
 * hourly, so this is the next Tick's, not the one that asked.
 */
const READ_BACK_AFTER_MS = 30 * 60_000;

/**
 * What later Ticks read of each ask on this head from its check runs: a check
 * whose latest run started after the line and ended red failed again; one
 * with no run started since, once the line is old enough, was refused (the
 * claim marked it started) or had no run behind its label, which then comes
 * off. Each is said once, with a done line. A check green now is a Flaky
 * check, which the read of the passed head reports; one running is left.
 */
function readBackActions(now: string, pullRequest: PullRequestSnapshot, head: PassedHeadChecks): Action[] {
  const done = new Set(pullRequest.gateReruns.flatMap((mark) => (mark.kind === "done" && mark.headSha === head.headSha ? mark.checks : [])));
  const found: Record<"red-again" | "refused" | "no-run", string[]> = { "red-again": [], refused: [], "no-run": [] };
  for (const mark of pullRequest.gateReruns) {
    if (mark.kind !== "asked" || mark.headSha !== head.headSha) continue;
    const since = Date.parse(mark.postedAt);
    for (const { name } of mark.checks) {
      if (done.has(name)) continue;
      const latest = latestRun(head.checkRuns, name);
      if (latest === undefined || latest.conclusion === "success" || latest.status !== "completed") continue;
      const startedSince = latest.startedAt !== null && Date.parse(latest.startedAt) > since;
      if (startedSince) {
        if (isRed(latest)) found["red-again"].push(name);
      } else if (Date.parse(now) - since >= READ_BACK_AFTER_MS) {
        found[mark.started ? "refused" : "no-run"].push(name);
      }
      done.add(name);
    }
  }
  const lines = (["red-again", "refused", "no-run"] as const).flatMap((why) => (found[why].length === 0 ? [] : [doneLine(pullRequest.number, head.headSha, found[why], why)]));
  const labelOff: Action[] =
    found["no-run"].length > 0 && pullRequest.labels.includes(RERUN_CHECKS_LABEL) ? [{ kind: "remove-label", issue: pullRequest.number, label: RERUN_CHECKS_LABEL }] : [];
  return [...lines, ...labelOff];
}

/**
 * The Tick's gate re-runs: for each open agent PR at the Merge gate whose
 * latest pass, on its current head, names an Unrelated failure still red
 * there, the ask, once per PR, head and check; and what came of each ask
 * on that head, read back.
 */
export function gateRerunGate(now: string, snapshot: Snapshot): Plan {
  const { passedHeads, conflicts } = snapshot;
  if (passedHeads === null || typeof passedHeads === "string" || conflicts === null) {
    return { kind: "nothing", reason: "The Tick read no passed head at the Merge gate, so it asks no re-run of an Unrelated failure there" };
  }
  const actions = passedHeads.flatMap((head) => {
    const pullRequest = conflicts.pullRequests.find((candidate) => candidate.pullRequest.number === head.pullRequest)?.pullRequest;
    return pullRequest === undefined || passedHeadAtGate(pullRequest) !== head.headSha ? [] : [...readBackActions(now, pullRequest, head), ...askActions(pullRequest, head)];
  });
  return actions.length === 0
    ? { kind: "nothing", reason: "No pass at the Merge gate names an Unrelated failure still red on its head that the Kit hasn't re-run there" }
    : { kind: "act", actions };
}

/**
 * agent:rerun-checks added to a pull request (#783): on an agent PR at the
 * Merge gate whose head the Kit's line asked one more re-run on, and not yet
 * started, it routes to the Re-run red checks job for that line's checks; the
 * claim takes it off as the run starts and marks the line started. Anywhere
 * else, or a second time for a head, by anyone, it comes off with one line
 * saying why.
 */
export function rerunChecksOnLabel(pullRequest: PullRequestSnapshot): Plan {
  const { number, headSha } = pullRequest;
  const short = headSha.slice(0, 7);
  const decline = (why: string): Plan => ({ kind: "act", actions: declineTrigger(number, RERUN_CHECKS_LABEL, why) });
  if (!pullRequest.isAgent) return decline(`#${number} isn't an agent PR`);
  if (passedHeadAtGate(pullRequest) === null) return decline(`#${number} isn't at the Merge gate with a pass on its head, ${short}`);
  const asks = pullRequest.gateReruns.filter((mark): mark is Extract<GateRerunMark, { kind: "asked" }> => mark.kind === "asked" && mark.headSha === headSha);
  const ask = asks.find((mark) => !mark.started);
  if (ask === undefined) {
    return decline(
      asks.length > 0
        ? `the Kit re-runs an Unrelated failure once more on a head, and has on ${short} already`
        : `no line from the Kit asks for one more re-run on ${short}, which the hourly Tick asks for an Unrelated failure at the Merge gate`,
    );
  }
  return {
    kind: "act",
    actions: [
      { kind: "remove-label", issue: number, label: RERUN_CHECKS_LABEL },
      { kind: "mark-gate-rerun-started", pullRequest: number, node: ask.node },
      { kind: "rerun-checks", pullRequest: number, headSha, checks: ask.checks },
    ],
  };
}

/** Whether one more re-run of `check` at the Merge gate is done on this head without it reading green, skipped included (#783). */
export function gateRerunSpent(pullRequest: Pick<PullRequestSnapshot, "gateReruns">, headSha: string, check: string): boolean {
  return pullRequest.gateReruns.some((mark: GateRerunMark) => mark.kind === "done" && mark.headSha === headSha && mark.checks.includes(check));
}
