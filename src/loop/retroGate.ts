// The retro gate (#151): on the hourly scheduled tick, whether to open this
// week's pending Retro, whose opening starts the Retro's run.
import { RETRO_LABEL } from "./labels.ts";
import { RETRO_PENDING_MARKER, retroMarker } from "./markers.ts";
import { retrosIn, retroWindowStart } from "./retro.ts";
import type { Action, KitConfig, Plan, Snapshot } from "./types.ts";
import { dateOf, heldBack, readable, scheduledTickWith, weekStart } from "./weeklyGate.ts";

/**
 * The scheduled tick with the retro gate: closes the weekly-limit issue after
 * its reset, as scheduledTick does, alongside opening a pending Retro when
 * one is due. Nothing calls it until the switch-on Ticket (#228), which runs
 * the retro gate beside the audit gate (scheduledTickWith).
 */
export function scheduledTickWithRetroGate(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  return scheduledTickWith([retroGate], now, snapshot, config);
}

/** The retro gate on its own: a pending Retro to open, or why there's none this tick. */
export function retroGate(now: string, snapshot: Snapshot, config: KitConfig): Plan {
  const { day } = config.retro;
  if (day === null) return { kind: "nothing", reason: "The Retro is off: retro.day is null" };
  const slice = snapshot.retro;
  if (slice === null) {
    return { kind: "fail", failure: "infrastructure", reason: "The snapshot is missing the retro slice the retro gate weighs" };
  }
  const held = heldBack("Retro", day, retrosIn(slice.issues), now, snapshot.kitIssues);
  if (held !== null) return { kind: "nothing", reason: held };
  // The store's opt-in step isn't done: a Retro would have nothing to read, and isn't worth a notice (#139).
  if (!slice.storeReady) return { kind: "nothing", reason: "The fabrik-runs store isn't ready: the Fabrik App isn't on it, or it isn't private" };

  // The slice counts what's new from the same window start (src/github/snapshot.ts).
  const since = retroWindowStart(now, slice.issues);
  if (!slice.agentPullRequestClosed && !slice.escapeFiled) {
    return { kind: "nothing", reason: `Nothing is new since ${readable(Date.parse(since))}: no agent PR merged or closed, and no escape was filed` };
  }
  return { kind: "act", actions: [pendingRetro(now, since)] };
}

/**
 * This week's pending Retro, reading the window from `since` to the tick at
 * `now`: no state label, assignee or mention, so opening it buzzes nobody.
 */
function pendingRetro(now: string, since: string): Action {
  return {
    kind: "open-issue",
    title: `Retro: week of ${dateOf(weekStart(now))}`,
    body: [
      `The Retro is reading the factory's runs since ${readable(Date.parse(since))}, and this issue fills in when it's done.`,
      "",
      retroMarker(now),
      RETRO_PENDING_MARKER,
    ].join("\n"),
    labels: [RETRO_LABEL],
    assignees: [],
  };
}
