// A kept row read back (#793): a reader that keeps the rows the read library
// gave it at one release reads them at a later one through readRow, so it
// holds no step of its own for what a row has gained since (ADR-0020). Each
// Standing a row holds is read through readStanding (src/kit/keptStanding.ts),
// and a release that adds a field to `Row` writes what a row kept before it
// reads as here (docs/releasing.md). Everything that takes kept rows refuses
// ones that didn't come back this way (refuseRowsOfOtherSchema). Pure, no I/O.
import { readStanding } from "../kit/keptStanding.ts";
import { refuseOtherSchema } from "../kit/standing.ts";
import type { Row } from "./rows.ts";

/**
 * Each field `Row` has gained since the read library first shipped (v3.1.0),
 * as a row kept before it reads, with none of it: `shots` (v4.1.0), no
 * Evidence shots, and `operatorSession` (#951), no Operator session that
 * reported itself on the issue. `staging` (#855) is not here: it is an optional key, on a
 * row only in a repo that declares `staging`, so a row kept before it is
 * already a row with none of it and reads as it was kept. Nor is its `trial`
 * (#965), a field of what the key holds and not of the row: keptStagingOf reads
 * a `staging` kept before it.
 */
const NOT_ON_AN_EARLIER_ROW = { shots: null, operatorSession: null } as const satisfies Partial<Row>;

/** A Follow-up as a row kept it: with no kind on a row kept before a Follow-up had one (#885). */
type KeptFollowUp = Omit<Row["followUps"][number], "kind"> & Partial<Pick<Row["followUps"][number], "kind">>;

/** Where to try a merged pull request on staging as a row kept it: with no `trial` on a row kept before a row gave its Trial steps (#965). */
type KeptStaging = Omit<NonNullable<Row["staging"]>, "trial"> & Partial<Pick<NonNullable<Row["staging"]>, "trial">>;

/** A row as a reader may have kept it at any release since v3.1.0: its Standings of any schema, and none of the fields a row has gained since unless its release had them. */
type KeptRow = Omit<Row, "standing" | "plainPullRequest" | "followUps" | "staging" | keyof typeof NOT_ON_AN_EARLIER_ROW> &
  Partial<Pick<Row, keyof typeof NOT_ON_AN_EARLIER_ROW>> & {
    readonly standing: unknown;
    readonly plainPullRequest: (Omit<NonNullable<Row["plainPullRequest"]>, "own"> & { readonly own: unknown }) | null;
    readonly followUps?: readonly KeptFollowUp[];
    readonly staging?: KeptStaging;
  };

/**
 * A kept row's Follow-ups as this release has them: one kept before a
 * Follow-up had a kind is an idea, as every Follow-up was then a link the
 * Operator opened or left (#885). The list itself when each has its kind.
 */
function followUpsOf(kept: readonly KeptFollowUp[]): Row["followUps"] {
  return kept.every((followUp) => "kind" in followUp) ? (kept as Row["followUps"]) : kept.map((followUp) => ({ ...followUp, kind: followUp.kind ?? "idea" }));
}

/**
 * Where to try a kept row's change on staging as this release has it: one
 * kept before a row gave its Trial steps has none, as a pull request with no
 * marker has (#965). The value itself when it has its `trial`.
 */
function keptStagingOf(kept: KeptStaging): NonNullable<Row["staging"]> {
  return "trial" in kept ? (kept as NonNullable<Row["staging"]>) : { ...kept, trial: null };
}

/**
 * A row a reader kept, as a row of this release: each Standing it holds read
 * at the current schema (readStanding), its own and, on a Pairing session's
 * row, the issue's own under `plainPullRequest.own`; and each field a row has
 * gained since it was kept read as a row with none of it, so one kept before
 * v4.1.0 has `shots` null, one kept before a row carried its Operator
 * session has `operatorSession` null (#951), one kept before a Follow-up had a kind has each
 * of its Follow-ups an idea, and one kept with `staging` before a row gave
 * its Trial steps has `staging.trial` null (#965). Every other field is as
 * it was kept, and a row of this release comes back as it is. Null for
 * anything that isn't a row, and for a row holding a Standing that doesn't
 * read, a newer Kit's among them (newerStandingSchemaOf). Beyond its
 * Standings' schemas it checks nothing of what it is given.
 */
export function readRow(kept: unknown): Row | null {
  if (typeof kept !== "object" || kept === null) return null;
  const row = kept as KeptRow;
  const standing = readStanding(row.standing);
  const keptOwn = row.plainPullRequest?.own ?? null;
  const own = keptOwn === null ? null : readStanding(keptOwn);
  if (standing === null || (keptOwn !== null && own === null)) return null;
  const plainPullRequest = (own === keptOwn ? row.plainPullRequest : { ...row.plainPullRequest, own }) as Row["plainPullRequest"];
  const followUps = Array.isArray(row.followUps) ? followUpsOf(row.followUps) : undefined;
  const staging = typeof row.staging === "object" && row.staging !== null ? keptStagingOf(row.staging) : undefined;
  const asKept =
    standing === row.standing &&
    plainPullRequest === row.plainPullRequest &&
    followUps === row.followUps &&
    staging === row.staging &&
    Object.keys(NOT_ON_AN_EARLIER_ROW).every((field) => field in row);
  return asKept
    ? (kept as Row)
    : ({ ...NOT_ON_AN_EARLIER_ROW, ...row, standing, plainPullRequest, ...(followUps === undefined ? {} : { followUps }), ...(staging === undefined ? {} : { staging }) } as Row);
}

/**
 * Refuses kept rows holding a Standing of another schema (refuseOtherSchema),
 * a row's own or the issue's own a Pairing session's row carries, before
 * anything else of the rows is read: what everything that takes kept rows
 * does first, the joins, the join with staging among them, headsToCheck,
 * mergesToRead, stagingMergesToRead, commitsToCheck and owedRollInsOf, so a
 * kept row reaches one only through readRow.
 */
export function refuseRowsOfOtherSchema(rows: readonly Row[]): void {
  for (const { standing, plainPullRequest } of rows) {
    refuseOtherSchema(standing);
    if (plainPullRequest?.own != null) refuseOtherSchema(plainPullRequest.own);
  }
}
