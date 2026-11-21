// A kept Standing read back (#793): a reader that keeps the Standings the
// read library gave it at one release reads them at a later one through
// readStanding, as a stored Run record is read through readRunRecord
// (./runRecord.ts), so no reader holds a step of its own between schemas
// (ADR-0020). A release that moves STANDING_SCHEMA writes the step from the
// schema before it here (docs/releasing.md). Pure, no I/O.
import { inBlockerOrder } from "../loop/blockers.ts";
import { type Standing, STANDING_SCHEMA, type StandingName, type StandingNamed } from "./standing.ts";

/**
 * A Standing a reader kept, at the current schema: one at STANDING_SCHEMA as
 * it is, and one of an earlier schema brought forward and stamped with the
 * current one. A schema 1 `blocked` Standing (v3.1.0 to v3.4.1), which kept
 * its own repo's Blockers by number and counted no hidden ones, names each by
 * the Standing's own repo, with none hidden (#771); a schema 1 Standing of
 * any other name changes only its `schema`. Null for anything that isn't a
 * Standing of a schema the Kit knows, a newer Kit's (newerStandingSchemaOf)
 * among them. It checks the schema and nothing else of what it is given, and
 * records nowhere the schema a Standing was kept at.
 */
export function readStanding(kept: unknown): Standing | null {
  if (typeof kept !== "object" || kept === null) return null;
  const { schema } = kept as { schema?: unknown };
  if (schema === STANDING_SCHEMA) return kept as Standing;
  return upgraded(kept, schema);
}

/** A `blocked` Standing's detail as schema 1 held it: its own repo's Blockers, by number, with no count of the hidden ones (#771). */
type Schema1BlockedDetail = Omit<StandingNamed<"blocked">["detail"], "blockers" | "hiddenBlockers"> & { readonly blockers: readonly number[] };

/** A Standing as schema 1 held it: a `blocked` one's detail apart, as the current schema does. */
type Schema1 = {
  readonly [N in StandingName]: Omit<StandingNamed<N>, "schema" | "detail"> & { readonly schema: 1; readonly detail: N extends "blocked" ? Schema1BlockedDetail : StandingNamed<N>["detail"] };
}[StandingName];

/** A kept Standing older than the current schema at the current one (readStanding), or null for a schema the Kit doesn't know. */
function upgraded(kept: object, schema: unknown): Standing | null {
  if (schema === 1) return fromSchema1(kept as Schema1);
  return null;
}

/** A schema 1 Standing at schema 2: a `blocked` one's Blockers each by the Standing's own repo, the only repo schema 1 recorded Blockers of, in the order schema 2 keeps them. */
function fromSchema1(kept: Schema1): Standing {
  if (kept.name !== "blocked") return { ...kept, schema: STANDING_SCHEMA };
  const blockers = inBlockerOrder(kept.detail.blockers.map((number) => ({ repo: kept.repo, number })));
  return { ...kept, schema: STANDING_SCHEMA, detail: { ...kept.detail, blockers, hiddenBlockers: 0 } };
}

/** The schema of a kept Standing a newer Kit wrote than the one reading it, one past STANDING_SCHEMA: null for any other, as newerSchemaOf is for a Run record. */
export function newerStandingSchemaOf(kept: unknown): number | null {
  if (typeof kept !== "object" || kept === null) return null;
  const { schema } = kept as { schema?: unknown };
  return typeof schema === "number" && Number.isInteger(schema) && schema > STANDING_SCHEMA ? schema : null;
}
