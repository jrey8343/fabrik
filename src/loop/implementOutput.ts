// The Implementer output contract: alongside its commits (passed out as a git
// bundle), an Implement agent job emits the title and summary of the draft PR
// its push job opens. Both sides check it, so a malformed output never half-applies.
import { hasDynamicSegment, isRoute } from "../kit/config.ts";
import { isCommentIdList } from "./considered.ts";

export interface ImplementOutput {
  /** The PR title, one line. */
  readonly title: string;
  /** Markdown for the PR body: what the PR as a whole changes, and how it was tested. */
  readonly summary: string;
  /**
   * For a run on an existing PR (a retry or a Request-changes run): what this
   * run was asked to fix and what it changed, posted as a comment on the PR
   * while `summary` replaces its body. A first run leaves it out.
   */
  readonly fix?: string;
  /**
   * For a run on an existing PR: the ids of the Operator comments it weighed,
   * which its fix comment links when the run was given them (src/loop/considered.ts).
   * Left out when the run gave anything but a list of ids: a bad list never fails the run.
   */
  readonly operatorCommentsConsidered?: readonly string[];
  /**
   * When the change touched UI: the routes it shows on, each a path starting
   * with `/`, so UI evidence is captured where the change is. Left out when
   * the run gave anything but a list of paths: a bad list never fails the run.
   */
  readonly routes?: readonly string[];
  /**
   * On a Product repo that uses Evidence shots (#819): the names of the
   * shots that show the change, as it gave them, in its order. The push job
   * holds them to the manifest's name rule and counts the first four
   * (src/evidence/uiEvidence.ts). Left out when the run gave anything but a
   * list of names: a bad list never fails the run.
   */
  readonly shots?: readonly string[];
  /**
   * On a Product repo that uses Evidence shots: its one sentence that nothing
   * a person sees changes, and why. Left out when the run gave anything but
   * text. Named shots win over it.
   */
  readonly nothingVisible?: string;
  /**
   * On a Product repo that declares `staging` (#963), for a pull request that
   * will ask for a Staging trial: its Trial steps, written for the pull
   * request as it now stands, which the push job keeps on it
   * (trialStepsMarker, src/loop/markers.ts). Left out when the run gave
   * anything but Trial steps (trialStepsOf): a bad `trial` never fails the run.
   */
  readonly trial?: TrialSteps;
  /**
   * For a Request-changes run alone: its two answers about the review it was
   * started for, which the Kit records on the PR (#369). Every other run
   * leaves them out.
   */
  readonly answers?: ImplementerAnswers;
  /**
   * For a conflict-only run alone (#845): the pull request already merged into
   * `main` that makes the whole of this PR's change, so that nothing of the
   * PR's own is left to keep, by its number. The Kit weighs it only on a
   * conflict-only run, and only once it has checked the PR it names merged
   * into `main` since this PR's merge base (src/loop/implement.ts). Left out
   * when the run gave anything but a positive whole number: a bad number never
   * fails the run.
   */
  readonly supersededBy?: number;
  /**
   * For a Request-changes run alone (#884): the points of the Operator's
   * Request changes that asked, in words, to be issues of their own. The run
   * leaves each unbuilt and returns it here, and the Kit opens it as a
   * Spin-off in the plan that lands the run (src/loop/implement.ts). No other
   * run's output carries them: the Kit never reads the field there.
   */
  readonly spinOffs?: readonly RequestedSpinOff[];
  /**
   * For a Request-changes run alone (#884): the run's statement that every
   * point of every Request changes it was given was asked for, in the
   * Operator's words, as an issue of its own, so it built nothing. Kit code
   * can't read a point, only an ask, so a run that committed nothing returns
   * its pull request to the Merge gate only with this beside what Kit code
   * checks itself (src/loop/implement.ts). Present only when the run gave
   * `true`: anything else is no statement, and never fails the run.
   */
  readonly onlySpinOffs?: true;
}

/**
 * A pull request's Trial steps (GLOSSARY.md), as the Implementer writes them
 * (#963): what the Operator checks in its Staging trial. Each text is the
 * agent's, so a reader shows it as text and builds no link from it but the
 * one to a step's `route` on the staging site.
 */
export interface TrialSteps {
  /** One short paragraph, in plain language, of what changed for a person using the product. */
  readonly summary: string;
  /** What to do and what to see, in the order to do it: one step at least. */
  readonly steps: readonly TrialStep[];
}

/** One of a pull request's Trial steps. */
export interface TrialStep {
  /**
   * The page the step starts on: a route (isRoute) with no dynamic segment
   * (hasDynamicSegment), so it is a page of the staging site as written. A
   * step on a record's page gives the nearest page with a fixed address, and
   * its `do` says how to reach the record. Left out where the step gave none.
   */
  readonly route?: string;
  /** What the person does, in plain words. */
  readonly do: string;
  /** What they should then see, concrete enough to check by looking. */
  readonly expect: string;
}

/**
 * A point of a Request changes the Operator asked to be its own issue, as the
 * Request-changes run returns it (#884).
 */
export interface RequestedSpinOff {
  /** The new issue's title, one line. */
  readonly title: string;
  /** The new issue's body, which stands alone and quotes the Operator's words. */
  readonly body: string;
  /**
   * The id of the Request changes, or of the inline comment in one, that
   * asked for it, as the run's prompt heads it: `review-<id>` or
   * `inline-<id>` (src/agent/operatorComments.ts).
   */
  readonly from: string;
}

/**
 * A Request-changes run's two independent answers about the review it was
 * started for: whether it holds a Review miss (GLOSSARY.md), and whether it
 * amends the Ticket. What the Kit records, counts and hands the Retro.
 */
export interface RequestChangesAnswers {
  readonly reviewMiss: boolean;
  readonly amendsTicket: boolean;
}

/** The answers as the Implementer gives them: with each point that is a Review miss named, none when there is no Review miss. */
export interface ImplementerAnswers extends RequestChangesAnswers {
  readonly points: readonly string[];
}

/**
 * Which kind of Implement run an output comes from, and so which contract it's
 * checked against: a first run's, a run on an existing PR's (a retry or a
 * conflict-only run), or a Request-changes run's.
 */
export type ImplementRunKind = "first" | "pull-request" | "request-changes";

export type ImplementOutputResult =
  | { readonly ok: true; readonly output: ImplementOutput }
  | { readonly ok: false; readonly errors: readonly string[] };

/** GitHub caps PR titles at 256 characters. */
const MAX_TITLE = 256;

/** Whether a run's routes are a list of paths starting with `/`; anything else reads as none named. */
function isRouteList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isRoute);
}

/** Whether a run's shots are a list of names, as text; anything else, an empty list too, reads as none named. */
function isShotList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === "string");
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * A value as Trial steps, or null when it isn't them. The one rule for their
 * shape: both sides of the contract read a run's `trial` by it, and so does
 * the reader of the marker that keeps them on the pull request
 * (trialStepsIn, src/loop/markers.ts).
 */
export function trialStepsOf(value: unknown): TrialSteps | null {
  if (!isRecord(value)) return null;
  const { summary, steps: written } = value;
  if (!isText(summary) || !Array.isArray(written) || written.length === 0) return null;
  const steps: TrialStep[] = [];
  for (const step of written as unknown[]) {
    // One step that isn't a step leaves the whole of them out: the rest would read as steps nobody wrote in that order.
    if (!isRecord(step) || !isText(step.do) || !isText(step.expect)) return null;
    const { route } = step;
    // A route that is no page of the staging site as written is left off, and its step kept: the step still says what to do.
    steps.push({ ...(isRoute(route) && !hasDynamicSegment(route) ? { route } : {}), do: step.do.trim(), expect: step.expect.trim() });
  }
  return { summary: summary.trim(), steps };
}

/** Whether a value is an object with keys to read, and no list. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks an already-parsed value against the contract, naming every problem. */
export function readImplementOutput(value: unknown): ImplementOutputResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["Implementer output must be a JSON object"] };
  }
  const { title, summary, fix, operatorCommentsConsidered: considered, routes, shots, nothingVisible, supersededBy } = value as Record<string, unknown>;
  const trial = trialStepsOf((value as Record<string, unknown>).trial);
  const errors: string[] = [];
  if (!isText(title) || title.includes("\n") || title.length > MAX_TITLE) {
    errors.push(`title must be one non-empty line of at most ${MAX_TITLE} characters`);
  }
  if (!isText(summary)) errors.push("summary must be non-empty Markdown");
  if (fix !== undefined && !isText(fix)) errors.push("fix, when given, must be non-empty Markdown");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    output: {
      title: (title as string).trim(),
      summary: (summary as string).trim(),
      ...(fix === undefined ? {} : { fix: (fix as string).trim() }),
      // A malformed list never fails the run: it reads as none weighed.
      ...(isCommentIdList(considered) ? { operatorCommentsConsidered: considered } : {}),
      // Nor does a malformed list of routes: it reads as none named.
      ...(isRouteList(routes) ? { routes } : {}),
      // Nor do malformed shots, or a sentence that isn't text: each reads as not given.
      ...(isShotList(shots) ? { shots } : {}),
      ...(isText(nothingVisible) ? { nothingVisible: nothingVisible.trim() } : {}),
      // Nor does a `trial` that isn't Trial steps: it reads as left out.
      ...(trial === null ? {} : { trial }),
      // Nor does a superseding PR that isn't a number: it reads as none named.
      ...(Number.isInteger(supersededBy) && (supersededBy as number) > 0 ? { supersededBy: supersededBy as number } : {}),
    },
  };
}

/**
 * The contract for a run on an existing PR: the output a first run gives,
 * plus the `fix` that says what this run changed.
 */
export function readPullRequestRunOutput(value: unknown): ImplementOutputResult {
  const result = readImplementOutput(value);
  if (result.ok && result.output.fix === undefined) {
    return { ok: false, errors: ["fix must be non-empty Markdown on a retry or Request-changes run"] };
  }
  return result;
}

/**
 * The contract for a Request-changes run: a run on an existing PR's, plus its
 * two answers about the review it was started for, both required, the
 * Spin-offs it set aside (#884), if any, and its statement that no point was
 * to be built (`onlySpinOffs`), if it made it. `given` is the id of each Request
 * changes, and of each comment on the code in one, that the run was given: a
 * Spin-off whose `from` names anything else is refused. The agent job passes
 * the ids its prompt headed, and the push job the ones its own read of the
 * pull request finds, so neither takes the other's word.
 */
export function readRequestChangesRunOutput(value: unknown, given?: readonly string[]): ImplementOutputResult {
  const result = readPullRequestRunOutput(value);
  if (!result.ok) return result;
  const { reviewMiss, reviewMissPoints, amendsTicket, spinOffs: written, onlySpinOffs } = value as Record<string, unknown>;
  const errors: string[] = [];
  const spinOffs = readSpinOffs(written, given, errors);
  if (typeof reviewMiss !== "boolean") errors.push("reviewMiss must be true or false on a Request-changes run");
  if (typeof amendsTicket !== "boolean") errors.push("amendsTicket must be true or false on a Request-changes run");
  const points = Array.isArray(reviewMissPoints) && reviewMissPoints.length > 0 && reviewMissPoints.every(isText) ? reviewMissPoints : null;
  if (reviewMiss === true && points === null) errors.push("reviewMissPoints must name each point that is a Review miss");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    output: {
      ...result.output,
      // A no names no point, whatever the run listed.
      answers: { reviewMiss: reviewMiss as boolean, points: reviewMiss === true ? (points as string[]).map((point) => point.trim()) : [], amendsTicket: amendsTicket as boolean },
      ...(spinOffs.length === 0 ? {} : { spinOffs }),
      // Only `true` states it: anything else leaves the pull request to be handed back.
      ...(onlySpinOffs === true ? { onlySpinOffs } : {}),
    },
  };
}

/**
 * A Request-changes run's `spinOffs` (#884), with each problem added to
 * `errors`, a Spin-off named by its place in the list. Left out, or an empty
 * list, it is none. A bad one is refused, never dropped: the Operator asked
 * for it in words, so the run puts it right while it still can.
 */
function readSpinOffs(written: unknown, given: readonly string[] | undefined, errors: string[]): RequestedSpinOff[] {
  if (written === undefined) return [];
  if (!Array.isArray(written)) {
    errors.push("spinOffs must be a list of Spin-offs, each with a title, a body and a from");
    return [];
  }
  return written.flatMap((spinOff: unknown, i) => {
    const { title, body, from } = (typeof spinOff === "object" && spinOff !== null ? spinOff : {}) as Record<string, unknown>;
    if (!isText(title) || title.includes("\n") || title.length > MAX_TITLE || !isText(body) || !isText(from)) {
      errors.push(`spin-off ${i + 1} needs a title of one non-empty line of at most ${MAX_TITLE} characters, body text, and from as the id that heads what asked for it`);
      return [];
    }
    // The ids are to hand wherever the run's output is checked, on both sides; where they aren't, as for the prompt's own example, any id reads.
    if (given !== undefined && !given.includes(from.trim())) {
      errors.push(`spin-off ${i + 1} names \`${from.trim()}\` in from, which isn't a Request changes, or a comment on the code in one, that this run was given`);
      return [];
    }
    return [{ title: title.trim(), body: body.trim(), from: from.trim() }];
  });
}

/**
 * The contract each kind of run is checked against, which the agent side's
 * schema and the push job both read. `given` is weighed by a Request-changes
 * run's alone (readRequestChangesRunOutput).
 */
export const IMPLEMENT_OUTPUT_READERS: Readonly<Record<ImplementRunKind, (value: unknown, given?: readonly string[]) => ImplementOutputResult>> = {
  first: readImplementOutput,
  "pull-request": readPullRequestRunOutput,
  "request-changes": readRequestChangesRunOutput,
};

/**
 * Parses the text an agent emitted, then checks it against the contract for
 * `run`, a first run's unless given, with the ids a Request-changes run's
 * Spin-offs may name in `from` when they are to hand.
 */
export function parseImplementOutput(text: string, run: ImplementRunKind = "first", given?: readonly string[]): ImplementOutputResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Implementer output is not valid JSON: ${(error as Error).message}`] };
  }
  return IMPLEMENT_OUTPUT_READERS[run](value, given);
}
