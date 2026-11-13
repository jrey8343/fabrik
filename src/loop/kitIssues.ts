// Kit-owned issues: a failure that stalls every run in a repo, not just one
// Ticket, buzzes the Operator once through an issue the Kit owns, rather than
// once per Ticket. A dead Claude token gets a "Rotate the Claude token" issue,
// with rotation on one per Subscription, which the Kit skips until the
// Operator closes it (#433);
// the weekly usage limit gets one per window, which a scheduled tick closes
// after the reset, or the Operator closes when the reset isn't known. They don't restart stalled Tickets: each Ticket's own
// failure comment names the trigger label to re-add. With rotation on, each
// Subscription gets its own weekly-limit issue, which stays quiet while
// another Subscription is free: only the one opened, or refused on, once none
// is free @-mentions the Operator. While none is free, each run due is held
// instead of started (src/loop/hold.ts), and it resumes once one is free, at
// the reset or sooner (src/loop/resume.ts), whichever mix of weekly-limit,
// usage-credits and token-rotation issues used them up (#470). A run killed
// for spending usage credits gets a usage-credits issue
// (src/loop/usageCreditsIssue.ts).
import type { HoldableRun } from "./heldRun.ts";
import { heldMarkerComment } from "./hold.ts";
import { DEAD_TICK_MARKER, earliestOf, NOTIFIED, notified, resetsAtMarker, resetsAtOf } from "./kitIssueMarks.ts";
import { DEAD_TICK_LABEL, READY_FOR_HUMAN, TOKEN_ROTATION_LABEL, WEEKLY_LIMIT_LABEL } from "./labels.ts";
import { readable } from "./readable.ts";
import {
  freeSubscriptions,
  type RanOn,
  rotationIsOn,
  subscriptionMarker,
  kitIssueSubscriptionOf,
} from "./subscriptions.ts";
import type { Action, CreatedIssue, InfrastructureFailure, KitConfig, KitIssueSnapshot, Plan, Snapshot } from "./types.ts";
import { usageCreditsNotice } from "./usageCreditsIssue.ts";

/** The repo-wide part of any snapshot: who the Operator is and which Kit-owned issues are open. */
export type RepoContext = Pick<Snapshot, "kitIssues" | "operator">;

/**
 * The failed run, as the Ticket's failure comment names it, and what it ran
 * on: with rotation on, the Kit's issues say which Subscription they're
 * about, and a weekly-limit notice knows whether another is free.
 */
export interface StalledRun extends RanOn {
  /** Such as "The Triage run on #7". */
  readonly run: string;
  readonly runUrl: string;
  /** When the weekly limit resets, if known. */
  readonly resetsAt: string | null;
  /** With rotation on, the run the Kit holds rather than fails, which the weekly-limit notice names. */
  readonly held?: HoldableRun;
  /** The Operator's time zone the notice writes its times in (src/loop/readable.ts); null for UTC. */
  readonly timeZone: string | null;
}

/**
 * Whether a Subscription other than the refused one is still free: listed,
 * with no open weekly-limit, usage-credits or token-rotation issue. Only with
 * rotation on can one be.
 */
export function anotherSubscriptionFree(
  kitIssues: readonly KitIssueSnapshot[],
  { subscription, rotation, subscriptions }: RanOn,
): boolean {
  return rotation && freeSubscriptions(kitIssues, { subscriptions }).some((free) => free !== subscription);
}

/** The token a dead-token notice says was refused: with rotation on, the Subscription's. */
export function refusedToken({ subscription, rotation }: Pick<RanOn, "subscription" | "rotation">): string {
  return rotation ? `the Claude token of the \`${subscription}\` Subscription` : "the Claude token";
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export interface RepoWideNotice {
  /** What the Kit does on its own issue. */
  readonly actions: readonly Action[];
  /** A line for the Ticket's failure comment, saying where the Operator hears about it. */
  readonly pointer: string;
  /** With rotation on, for the weekly limit: when the first open weekly-limit issue's limit resets, if known. */
  readonly firstReset?: string | null;
  /** With rotation on, for a refused run held: the weekly-limit issue its held marker went on, existing or opened by the Plan (#471). */
  readonly heldOn?: number | CreatedIssue;
}

/** The key the Plan opening a weekly-limit issue names it by, for a held line to link it (#471). */
const OPENED_WEEKLY_LIMIT = "weekly-limit";

/** The Kit-owned issue notice for a failure that stalls the whole repo, or null for one that doesn't. */
export function repoWideNotice(
  failure: InfrastructureFailure,
  snapshot: RepoContext,
  stalled: StalledRun,
): RepoWideNotice | null {
  switch (failure) {
    case "dead-token":
      return deadToken(snapshot, stalled);
    case "weekly-limit":
      return stalled.rotation ? subscriptionWeeklyLimit(snapshot, stalled) : weeklyLimit(snapshot, stalled);
    // Only with rotation on does the stream watch kill a run for spending usage credits.
    case "usage-credits":
      return stalled.rotation ? usageCreditsNotice(snapshot, stalled) : null;
    default:
      return null;
  }
}

/**
 * The scheduled tick: closes the weekly-limit issue once its reset time has
 * passed. With rotation on, it closes each Subscription's at its own reset.
 */
export function scheduledTick(now: string, { kitIssues }: Snapshot, config: Pick<KitConfig, "subscriptions" | "timeZone">): Plan {
  const limits = kitIssues.filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const [first] = limits;
  if (first === undefined) return { kind: "nothing", reason: "No weekly-limit issue is open" };
  if (!rotationIsOn(config)) return closedAtReset(now, first, null, config.timeZone);
  const plans = limits.map((issue) => closedAtReset(now, issue, kitIssueSubscriptionOf(issue, config), config.timeZone));
  const actions = plans.flatMap((plan) => (plan.kind === "act" ? plan.actions : []));
  if (actions.length > 0) return { kind: "act", actions };
  return { kind: "nothing", reason: plans.map((plan) => (plan.kind === "nothing" ? plan.reason : "")).join("; ") };
}

/**
 * The Tick closes its repo's open Dead-tick issue (#461) as completed on any
 * run, since running is all it takes. Only an issue with the marker the
 * daily check left in the App's own body counts.
 */
export function deadTickClosed(now: string, release: string | null, { kitIssues }: Pick<Snapshot, "kitIssues">, timeZone: string | null): Action[] {
  return kitIssues
    .filter((issue) => issue.labels.includes(DEAD_TICK_LABEL) && issue.body.includes(DEAD_TICK_MARKER))
    .flatMap((issue): Action[] => [
      { kind: "comment", issue: issue.number, body: tickStartedAgain(now, release, timeZone) },
      { kind: "close", issue: issue.number, reason: "completed" },
    ]);
}

/**
 * The comment closing a Dead-tick issue (#461) once a Tick has started again,
 * as the Tick itself posts it, in the Operator's time zone from the Kit
 * config, and as the store's daily check does, in its caller's.
 */
export function tickStartedAgain(at: string, release: string | null, timeZone: string | null): string {
  return `The hourly Tick started again at ${readable(at, timeZone)}${release === null ? "" : `, on Fabrik ${release}`}, so the Kit is closing this issue.`;
}

/** One weekly-limit issue, closed once its reset has passed, naming its Subscription when rotation is on. */
function closedAtReset(now: string, open: KitIssueSnapshot, subscription: string | null, timeZone: string | null): Plan {
  const resetsAt = resetsAtOf(open);
  if (resetsAt === null) {
    return { kind: "nothing", reason: `#${open.number} doesn't say when the weekly limit resets, so the Operator closes it` };
  }
  if (Date.parse(now) < Date.parse(resetsAt)) {
    return { kind: "nothing", reason: `The weekly limit in #${open.number} resets at ${readable(resetsAt, timeZone)}` };
  }
  return {
    kind: "act",
    actions: [
      {
        kind: "comment",
        issue: open.number,
        body:
          subscription === null
            ? `The weekly usage limit reset at ${readable(resetsAt, timeZone)}, so the Kit is closing this issue. Stalled Tickets stay stalled until their trigger label is re-added.`
            : `The weekly usage limit of the \`${subscription}\` Subscription reset at ${readable(resetsAt, timeZone)}, so the Kit is closing this issue.`,
      },
      { kind: "close", issue: open.number, reason: "completed" },
    ],
  };
}

function weeklyLimit({ kitIssues, operator }: RepoContext, stalled: StalledRun): RepoWideNotice {
  const { resetsAt } = stalled;
  const open = kitIssues.find((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const openResetsAt = open === undefined ? null : resetsAtOf(open);
  // A later reset time than the open issue's means its window is over: this is a new one.
  const newWindow =
    open !== undefined && openResetsAt !== null && resetsAt !== null && Date.parse(resetsAt) > Date.parse(openResetsAt);
  if (open !== undefined && !newWindow) {
    const body = notified(open)
      ? `${stalled.run} stalled on the limit too. [The run](${stalled.runUrl})`
      : [
          `@${operator} ${stalled.run} hit the weekly usage limit${resetsAt === null ? "" : `, which resets at ${readable(resetsAt, stalled.timeZone)}`}. Until then every agent run in this repo stalls. [The run](${stalled.runUrl})`,
          "",
          NOTIFIED,
        ].join("\n");
    return {
      actions: [{ kind: "comment", issue: open.number, body }],
      pointer: `The Kit is tracking this in #${open.number}.`,
    };
  }
  const title =
    resetsAt === null ? "The weekly usage limit is reached" : `The weekly usage limit is reached until ${readable(resetsAt, stalled.timeZone)}`;
  const when =
    resetsAt === null
      ? "When it resets isn't known, so close this issue yourself once agent runs work again."
      : `It resets at ${readable(resetsAt, stalled.timeZone)}.`;
  return {
    actions: [
      ...(open === undefined ? [] : [{ kind: "close" as const, issue: open.number, reason: "completed" as const }]),
      {
        kind: "open-issue",
        title,
        body: [
          // The @-mention is this issue's one notification.
          `@${operator} ${stalled.run} hit the weekly usage limit. ${when} Until then every agent run in this repo stalls, and the Kit comments here about each one.`,
          "",
          "## Steps",
          "",
          resetsAt === null
            ? "- [ ] Wait until agent runs work again: when the limit resets isn't known."
            : `- [ ] Wait for the limit to reset at ${readable(resetsAt, stalled.timeZone)}.`,
          "- [ ] Re-add the trigger label named in each stalled Ticket's failure comment, to run it again. The Kit doesn't restart them.",
          "",
          `${resetsAt === null ? "" : "The Kit closes this issue after the reset. "}Run \`/fabrik-pair\` on this issue to work through these steps with an agent.`,
          "",
          `[The first stalled run](${stalled.runUrl})`,
          "",
          NOTIFIED,
          ...(resetsAt === null ? [] : [resetsAtMarker(resetsAt)]),
        ].join("\n"),
        labels: [WEEKLY_LIMIT_LABEL],
        assignees: [],
      },
    ],
    pointer: "The Kit has opened a weekly-limit issue for the Operator.",
  };
}

/**
 * With rotation on: the refused Subscription's own weekly-limit issue. While
 * another Subscription is free it is opened, or commented on, quietly, since
 * the run goes on elsewhere. Once none is free, it is the one that @-mentions
 * the Operator, naming the earliest reset across the open weekly-limit
 * issues, unless one of them already did.
 */
function subscriptionWeeklyLimit({ kitIssues, operator }: RepoContext, stalled: StalledRun): RepoWideNotice {
  const { resetsAt, subscription } = stalled;
  const limits = kitIssues.filter((issue) => issue.labels.includes(WEEKLY_LIMIT_LABEL));
  const mine = limits.find((issue) => kitIssueSubscriptionOf(issue, stalled) === subscription);
  const others = limits.filter((issue) => issue !== mine);
  const mineResetsAt = mine === undefined ? null : resetsAtOf(mine);
  // A later reset time than the open issue's means its window is over: this is a new one.
  const newWindow =
    mine !== undefined && mineResetsAt !== null && resetsAt !== null && Date.parse(resetsAt) > Date.parse(mineResetsAt);
  const stayingOpen = mine !== undefined && !newWindow ? [...others, mine] : others;
  // A Subscription with an open usage-credits issue isn't free either.
  const unusable = kitIssues.filter((issue) => issue !== mine);
  const buzz = !anotherSubscriptionFree(unusable, stalled) && !stayingOpen.some(notified);
  const earliest = earliestOf([...others.map(resetsAtOf), mine !== undefined && !newWindow ? mineResetsAt : resetsAt]);
  const allUsedUp = [
    `${stalled.run} hit the weekly usage limit of the \`${subscription}\` Subscription, and every listed Subscription has now hit its limit.`,
    earliest === null ? "When the first resets isn't known." : `The first resets at ${readable(earliest, stalled.timeZone)}.`,
    "Until then every agent run in this repo stalls",
  ].join(" ");
  // A held run is named on the issue that buzzed, or buzzes now; else on this Subscription's own.
  const buzzed = buzz ? undefined : stayingOpen.find(notified);
  const elsewhere = buzzed !== undefined && buzzed !== mine;
  const heldHere = stalled.held === undefined || elsewhere ? [] : ["", heldMarkerComment(stalled.held, earliest, stalled.timeZone)];
  const heldThere =
    stalled.held === undefined || buzzed === undefined || !elsewhere
      ? []
      : [{ kind: "comment" as const, issue: buzzed.number, body: heldMarkerComment(stalled.held, earliest, stalled.timeZone) }];
  if (mine !== undefined && !newWindow) {
    const body = [
      buzz
        ? [`@${operator} ${allUsedUp}. [The run](${stalled.runUrl})`, "", NOTIFIED].join("\n")
        : `${stalled.run} was refused on the limit too. [The run](${stalled.runUrl})`,
      ...heldHere,
    ].join("\n");
    return {
      actions: [{ kind: "comment", issue: mine.number, body }, ...heldThere],
      pointer: `The Kit is tracking this in #${mine.number}.`,
      firstReset: earliest,
      ...(stalled.held === undefined ? {} : { heldOn: elsewhere ? buzzed.number : mine.number }),
    };
  }
  const title =
    resetsAt === null
      ? `The weekly usage limit of the \`${subscription}\` Subscription is reached`
      : `The weekly usage limit of the \`${subscription}\` Subscription is reached until ${readable(resetsAt, stalled.timeZone)}`;
  const when =
    resetsAt === null
      ? "When it resets isn't known, so close this issue yourself once it works again."
      : `It resets at ${readable(resetsAt, stalled.timeZone)}, and the Kit closes this issue then.`;
  const body = buzz
    ? [
        // The @-mention is this issue's one notification.
        `@${operator} ${allUsedUp}, and the Kit comments here about each one.`,
        "",
        "## Steps",
        "",
        // With no reset known, nothing closes this issue but the Operator, whose close resumes the held runs (#440).
        ...(earliest === null
          ? [
              `- [ ] ${UNKNOWN_RESET}`,
              "- [ ] Nothing to re-add: the Kit resumes each held run itself, in the order they were held.",
            ]
          : [
              `- [ ] Wait for the first limit to reset at ${readable(earliest, stalled.timeZone)}.`,
              "- [ ] Nothing to re-add: at the reset the Kit resumes each held run itself, in the order they were held.",
            ]),
        "",
        "Run `/fabrik-pair` on this issue to work through these steps with an agent.",
        "",
        `[The run](${stalled.runUrl})`,
        "",
        NOTIFIED,
      ]
    : [
        `${stalled.run} hit the weekly usage limit of the \`${subscription}\` Subscription. ${when} Until then the Kit runs agents on the other Subscriptions, and comments here about each run refused on this one.`,
        "",
        `[The run](${stalled.runUrl})`,
      ];
  return {
    actions: [
      ...(mine === undefined ? [] : [{ kind: "close" as const, issue: mine.number, reason: "completed" as const }]),
      {
        kind: "open-issue",
        title,
        body: [
          ...body,
          ...heldHere,
          "",
          subscriptionMarker(subscription),
          ...(resetsAt === null ? [] : [resetsAtMarker(resetsAt)]),
        ].join("\n"),
        labels: [WEEKLY_LIMIT_LABEL],
        assignees: [],
        ...(stalled.held === undefined || elsewhere ? {} : { key: OPENED_WEEKLY_LIMIT }),
      },
      ...heldThere,
    ],
    pointer: "The Kit has opened a weekly-limit issue for the Operator.",
    firstReset: earliest,
    ...(stalled.held === undefined ? {} : { heldOn: elsewhere ? buzzed.number : { created: OPENED_WEEKLY_LIMIT } }),
  };
}

/**
 * What a weekly-limit issue with no reset known asks of the Operator, with
 * rotation on: only their close ends it, and resumes the runs held on it (#440).
 */
const UNKNOWN_RESET =
  "The Kit doesn't know when this limit resets. Close this issue once agent runs work again, and the Kit resumes the held runs.";

/** The line pointing the Operator at a Pairing session, at the end of a rotation issue's steps. */
const PAIRING_LINE = "Run `/fabrik-pair` on this issue to work through these steps with an agent.";

/** How the dead-token notice words a refusal, with rotation on (naming its Subscription) or off. */
interface DeadTokenWording {
  readonly title: string;
  /** The opening of a new issue's body. */
  readonly refused: string;
  /** The new issue's steps after rotating the token, through the Pairing line. */
  readonly closingSteps: readonly string[];
  /** After "no agent run in this repo can start", before "until it's rotated". */
  readonly startsOn: string;
  /** After "was refused too", for a later refusal. */
  readonly too: string;
}

function deadTokenWording(stalled: StalledRun): DeadTokenWording {
  const token = capitalised(refusedToken(stalled));
  if (!stalled.rotation) {
    return {
      title: "Rotate the Claude token",
      refused: `The Claude token that every Fabrik run in this repo uses was refused (\`authentication_failed\`). ${stalled.run} was the first to fail, and no agent run can start until the token is rotated.`,
      closingSteps: [
        "- [ ] Re-add the trigger label on each Ticket the Kit commented on, to run it again.",
        "",
        `Then close this issue, so that the next dead token opens a fresh one. ${PAIRING_LINE}`,
      ],
      startsOn: "",
      too: "",
    };
  }
  return {
    title: `Rotate the Claude token of the \`${stalled.subscription}\` Subscription`,
    refused: `${token} was refused (\`authentication_failed\`). ${stalled.run} was the first to fail. Until this issue is closed the Kit runs no agent on that Subscription: it runs them on the other listed Subscriptions, and comments here about each other run refused on this one.`,
    closingSteps: [
      "- [ ] Close this issue, so that the Kit runs agents on that Subscription again.",
      "",
      "A run the Kit moved to another Subscription needs nothing from you. While no other Subscription is free, each run due is held until one is, not started, and the Kit resumes it itself.",
      "",
      PAIRING_LINE,
    ],
    startsOn: " on it",
    too: `, on the \`${stalled.subscription}\` Subscription`,
  };
}

/**
 * The rotation issue for the refused token: the one open issue with rotation
 * off, and the refused Subscription's own with rotation on, an issue naming
 * no Subscription read as the first listed one's.
 */
function rotationIssueFor(kitIssues: readonly KitIssueSnapshot[], stalled: StalledRun): KitIssueSnapshot | undefined {
  const open = kitIssues.filter((issue) => issue.labels.includes(TOKEN_ROTATION_LABEL));
  if (!stalled.rotation) return open[0];
  return open.find((issue) => kitIssueSubscriptionOf(issue, stalled) === stalled.subscription);
}

function deadToken({ kitIssues, operator }: RepoContext, stalled: StalledRun): RepoWideNotice {
  const open = rotationIssueFor(kitIssues, stalled);
  const wording = deadTokenWording(stalled);
  if (open === undefined) {
    return {
      actions: [
        {
          kind: "open-issue",
          title: wording.title,
          body: [
            wording.refused,
            "",
            "## Steps",
            "",
            `- [ ] Run \`claude setup-token\` and save the new token, with its expiry date, in the \`${stalled.subscription}\` item in the Fabrik 1Password vault.`,
            ...wording.closingSteps,
            "",
            `[The first refused run](${stalled.runUrl})`,
            "",
            NOTIFIED,
            ...(stalled.rotation ? [subscriptionMarker(stalled.subscription)] : []),
          ].join("\n"),
          labels: [READY_FOR_HUMAN, TOKEN_ROTATION_LABEL],
          // The assignment is this issue's one notification.
          assignees: [operator],
        },
      ],
      pointer: `The Kit has opened a ${wording.title} issue for the Operator.`,
    };
  }
  const body = notified(open)
    ? `${stalled.run} was refused too${wording.too}. [The run](${stalled.runUrl})`
    : [
        `@${operator} ${capitalised(refusedToken(stalled))} was refused (\`authentication_failed\`), so no agent run in this repo can start${wording.startsOn} until it's rotated. ${stalled.run} was the first to fail. [The run](${stalled.runUrl})`,
        "",
        NOTIFIED,
      ].join("\n");
  return {
    actions: [{ kind: "comment", issue: open.number, body }],
    pointer: `The Kit is tracking this in #${open.number}.`,
  };
}
