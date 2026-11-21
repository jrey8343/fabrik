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
 * Evidence shots.
 */
const NOT_ON_AN_EARLIER_ROW = { shots: null } as const satisfies Partial<Row>;

/** A row as a reader may have kept it at any release since v3.1.0: its Standings of any schema, and none of the fields a row has gained since unless its release had them. */
type KeptRow = Omit<Row, "standing" | "plainPullRequest" | keyof typeof NOT_ON_AN_EARLIER_ROW> &
  Partial<Pick<Row, keyof typeof NOT_ON_AN_EARLIER_ROW>> & {
    readonly standing: unknown;
    readonly plainPullRequest: (Omit<NonNullable<Row["plainPullRequest"]>, "own"> & { readonly own: unknown }) | null;
  };

/**
 * A row a reader kept, as a row of this release: each Standing it holds read
 * at the current schema (readStanding), its own and, on a Pairing session's
 * row, the issue's own under `plainPullRequest.own`; and each field a row has
 * gained since it was kept read as a row with none of it, so one kept before
 * v4.1.0 has `shots` null. Every other field is as it was kept, and a row of
 * this release comes back as it is. Null for anything that isn't a row, and
 * for a row holding a Standing that doesn't read, a newer Kit's among them
 * (newerStandingSchemaOf). Beyond its Standings' schemas it checks nothing of
 * what it is given.
 */
export function readRow(kept: unknown): Row | null {
  if (typeof kept !== "object" || kept === null) return null;
  const row = kept as KeptRow;
  const standing = readStanding(row.standing);
  const keptOwn = row.plainPullRequest?.own ?? null;
  const own = keptOwn === null ? null : readStanding(keptOwn);
  if (standing === null || (keptOwn !== null && own === null)) return null;
  const plainPullRequest = (own === keptOwn ? row.plainPullRequest : { ...row.plainPullRequest, own }) as Row["plainPullRequest"];
  const asKept = standing === row.standing && plainPullRequest === row.plainPullRequest && Object.keys(NOT_ON_AN_EARLIER_ROW).every((field) => field in row);
  return asKept ? (kept as Row) : { ...NOT_ON_AN_EARLIER_ROW, ...row, standing, plainPullRequest };
}

/**
 * Refuses kept rows holding a Standing of another schema (refuseOtherSchema),
 * a row's own or the issue's own a Pairing session's row carries, before
 * anything else of the rows is read: what everything that takes kept rows
 * does first, the joins, headsToCheck, mergesToRead and owedRollInsOf, so a
 * kept row reaches one only through readRow.
 */
export function refuseRowsOfOtherSchema(rows: readonly Row[]): void {
  for (const { standing, plainPullRequest } of rows) {
    refuseOtherSchema(standing);
    if (plainPullRequest?.own != null) refuseOtherSchema(plainPullRequest.own);
  }
}
