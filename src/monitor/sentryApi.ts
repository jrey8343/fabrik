// The Monitor's Sentry side (#148): reads the project's unresolved `error`
// and `fatal` groups, and the latest event of each group the Monitor core
// names, from the host `monitor.errors.url` names, with the Sentry token, into
// the facts the core plans from (./core.ts), through the Sentry translator
// (./sentry.ts). A missing or refused token and any other Sentry API error
// become facts the core reports, with a `::warning` annotation for a refused
// token or an error, never a failed run. Read-only. Its program is ./main.ts.
import type { MonitorErrors } from "../kit/config.ts";
import type { SentryGroupsRead, SentryRead } from "./core.ts";
import { type GroupFacts, groupFactsOf, type RawSentryEvent, type RawSentryGroup, withLatestEvent } from "./sentry.ts";

/** A failed Sentry API call, with the status it failed with, or null when it got no answer. */
class SentryError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "SentryError";
    this.status = status;
  }
}

type SentryGet = (path: string) => Promise<Response>;

/** GETs from the Sentry host `monitor.errors.url` names, with the token. */
function sentryClient(errors: MonitorErrors, token: string): SentryGet {
  const host = errors.url.replace(/\/+$/, "");
  return async (path) => {
    let response: Response;
    try {
      response = await fetch(`${host}${path}`, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new SentryError(`Sentry at ${host} didn't answer: ${messageOf(error)}`, null);
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new SentryError(`Sentry answered GET ${path.split("?")[0]} with ${response.status}: ${detail}`, response.status);
    }
    return response;
  };
}

/**
 * What reading Sentry gives when `monitor.errors` is set, null when it isn't:
 * the project's groups, or that the token is missing (`token` is empty when
 * its 1Password item is), refused, or that Sentry couldn't be read.
 */
export async function readSentry(errors: MonitorErrors | null, token: string): Promise<SentryRead | null> {
  if (errors === null) return null;
  if (token === "") return { kind: "no-token" };
  try {
    return await readGroups(sentryClient(errors, token), errors);
  } catch (error) {
    if (error instanceof SentryError && (error.status === 401 || error.status === 403)) {
      warned(error, "Sentry token rejected");
      return { kind: "token-rejected", status: error.status };
    }
    return { kind: "failed", error: warned(error) };
  }
}

/** The most pages of 100 groups the Monitor lists in one tick. */
const LISTING_PAGES = 10;

/** The `next` cursor in a Sentry `Link` header, or null when there are no more results. */
function nextCursor(link: string | null): string | null {
  return /<[^>]*>;\s*rel="next";\s*results="true";\s*cursor="([^"]+)"/.exec(link ?? "")?.[1] ?? null;
}

/** The project's unresolved `error` and `fatal` groups, with their 24-hour stats, as group facts, paging by the `Link` cursor. */
async function readGroups(get: SentryGet, errors: MonitorErrors): Promise<SentryGroupsRead> {
  const query = new URLSearchParams({ query: "is:unresolved level:[error,fatal]", statsPeriod: "24h", limit: "100" });
  const listing: RawSentryGroup[] = [];
  let cutShortAt: number | null = null;
  for (let page = 1; ; page++) {
    const response = await get(`/api/0/projects/${errors.org}/${errors.project}/issues/?${query}`);
    listing.push(...((await response.json()) as RawSentryGroup[]));
    const cursor = nextCursor(response.headers.get("link"));
    if (cursor === null) break;
    if (page === LISTING_PAGES) {
      cutShortAt = LISTING_PAGES * 100;
      break;
    }
    query.set("cursor", cursor);
  }
  const groupsWithoutStats = listing.filter((group) => group.stats?.["24h"] === undefined).length;
  return { kind: "read", groups: groupFactsOf(listing), groupsWithoutStats, cutShortAt, latestEventErrors: [] };
}

/**
 * The groups Sentry listed, with the latest event of each of these groups
 * read too. One whose latest event can't be read stays without it, its error
 * kept for the core's warning. Anything but listed groups comes back as it was.
 */
export async function withLatestEvents(
  sentry: SentryRead | null,
  errors: MonitorErrors | null,
  token: string,
  groups: ReadonlySet<string>,
): Promise<SentryRead | null> {
  if (sentry?.kind !== "read" || errors === null || groups.size === 0) return sentry;
  const get = sentryClient(errors, token);
  const withEvents: GroupFacts[] = [];
  const latestEventErrors = [...sentry.latestEventErrors];
  for (const group of sentry.groups) {
    if (!groups.has(group.id)) {
      withEvents.push(group);
      continue;
    }
    try {
      const response = await get(`/api/0/organizations/${errors.org}/issues/${encodeURIComponent(group.id)}/events/latest/`);
      withEvents.push(withLatestEvent(group, (await response.json()) as RawSentryEvent));
    } catch (error) {
      latestEventErrors.push({ group: group.id, error: warned(error) });
      withEvents.push(group);
    }
  }
  return { ...sentry, groups: withEvents, latestEventErrors };
}

/** The error's message, after annotating the run with it as a warning under this title. */
function warned(error: unknown, title = "Sentry unreachable"): string {
  const message = messageOf(error);
  console.log(`::warning title=${title}::${message}`);
  return message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
