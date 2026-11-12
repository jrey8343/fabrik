// The adapter's reads for a waiting replay request (#156): what accepting it
// weighs (ReplayAcceptance, src/kit/replay.ts), read only on a scheduled tick
// while a valid request waits. It holds no Replay rules: which Tickets are
// candidates, and which of their facts count, are src/kit/replayFacts.ts's,
// and which shas to read are replayReads's. The scheduled tick's snapshot
// gathers the rest of the replay slice (src/github/snapshot.ts).
import { INSTRUCTED_ROLES, instructionsPath, KIT_CONFIG_PATH, type KitConfigSources, resolveKitConfig, SKILLS_SOURCES_LOCK_PATH } from "../kit/config.ts";
import { isKitCommit } from "../kit/overlay.ts";
import { type BaseKitConfig, type MergedFile, type ReplayAcceptance, type ReplayCandidate, replayReads, type ReplayTick } from "../kit/replay.ts";
import { type MergedTicketFacts, replayCandidatesOf, replayTicketsIn } from "../kit/replayFacts.ts";
import { mergedAgentPullRequestsIn } from "../kit/retroEvidence.ts";
import type { RunRecord } from "../kit/runRecord.ts";
import { allPages, type ReadClient, type Repo } from "./client.ts";
import { gatherGitHubFacts } from "./facts.ts";

/**
 * The fabrik-runs store as the scheduled tick reads it, the way the Weekly
 * summary does (readStoreRunRecords on a checkout, src/kit/storeCheckout.ts):
 * read only when a replay issue the Operator filed is open.
 */
export interface ReplayStore {
  /**
   * Every Run record the tick's checkout holds, which must hold at least the
   * last two months of every Product repo's and every one of this repo's;
   * null when the store can't be read.
   */
  readonly records: () => Promise<readonly RunRecord[] | null>;
}

/**
 * What accepting a waiting request weighs, or null when no valid request
 * waits, or the store couldn't be read: this repo's candidate Tickets, from
 * its own records alone, with their merged PRs' facts; the Kit config at
 * each baseSha the pick weighs; and whether each candidate Kit sha a request
 * names is a commit in the Fabrik repo, on a branch or not (#449).
 */
export async function gatherReplayAcceptance(
  github: ReadClient,
  repo: Repo,
  now: string,
  tick: Pick<ReplayTick, "operator" | "issues">,
  records: readonly RunRecord[] | null,
): Promise<ReplayAcceptance | null> {
  const first = replayReads(tick, null);
  if (!first.acceptance || records === null) return null;
  const tickets = replayTicketsIn(records, `${repo.owner}/${repo.name}`);
  const [candidates, fabrikCommits] = await Promise.all([
    tickets.length === 0 ? [] : gatherCandidates(github, repo, now, tick.operator, records, tickets),
    fabrikCommitsOf(github, first.fabrikShas),
  ]);
  const { baseShas } = replayReads(tick, candidates);
  return { candidates, baseConfigs: await baseConfigsAt(github, repo, baseShas), fabrikCommits };
}

/**
 * Each of `tickets` as a candidate: its agent PRs merged in the window the
 * Weekly summary's facts reach (97 days), with whether a revert since its
 * merge, until now, reverted it and its Human touches as the summary counts
 * them; each last merged PR's files; and when each Ticket and its Spec were
 * last edited.
 */
async function gatherCandidates(
  github: ReadClient,
  repo: Repo,
  now: string,
  operator: string,
  records: readonly RunRecord[],
  tickets: readonly number[],
): Promise<ReplayCandidate[]> {
  const facts = await gatherGitHubFacts(github, repo, Date.parse(now), operator);
  // From any merge to now: a revert never comes before the merge it reverts.
  const merged = mergedAgentPullRequestsIn({ start: 0, end: Date.parse(now) + 1 }, { facts: [facts], operator }).flatMap(
    ({ pullRequest, mergedAt, reverted, humanTouches }): MergedTicketFacts[] => {
      const { ticket } = pullRequest;
      return ticket !== null && tickets.includes(ticket) ? [{ ticket, number: pullRequest.number, mergedAt, reverted, humanTouches }] : [];
    },
  );
  // Only each Ticket's last merged PR is weighed, and a reverted one never past its revert.
  const weighed = tickets.flatMap((ticket) => {
    const last = merged.filter((each) => each.ticket === ticket).toSorted((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt)).at(-1);
    return last === undefined || last.reverted ? [] : [last.number];
  });
  const [files, lastEdited] = await Promise.all([filesOf(github, repo, weighed), lastEditedOf(github, repo, tickets)]);
  return replayCandidatesOf({ repo: `${repo.owner}/${repo.name}`, records, merged, files, lastEdited });
}

/**
 * Every file each PR changed, as its diff names it: a removed file, and a
 * rename's old path, included. A replay arm's gates job reads its merged PR's
 * hidden tests through it too (src/kit/replay-hidden-tests-main.ts).
 */
export async function filesOf(github: ReadClient, repo: Repo, pullRequests: readonly number[]): Promise<Record<number, MergedFile[]>> {
  const each = await Promise.all(
    pullRequests.map(async (number): Promise<[number, MergedFile[]]> => {
      const files = await allPages<{ filename: string; status: string; previous_filename?: string }>(
        github,
        `/repos/${repo.owner}/${repo.name}/pulls/${number}/files`,
      );
      return [
        number,
        files.map(({ filename, status, previous_filename }) => ({
          path: filename,
          removed: status === "removed",
          ...(previous_filename === undefined ? {} : { from: previous_filename }),
        })),
      ];
    }),
  );
  return Object.fromEntries(each);
}

/** How many issues one query reads the edit times of. */
const EDITED_PER_QUERY = 50;

const EDITED_FIELDS = "lastEditedAt timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 1) { nodes { ... on RenamedTitleEvent { createdAt } } }";

interface EditedNode {
  lastEditedAt: string | null;
  timelineItems: { nodes: ({ createdAt?: string } | null)[] };
}

/**
 * When each Ticket and its Spec were last edited: the later of its body's
 * last edit and its title's last rename, never `updatedAt`, which a comment
 * or a label moves.
 */
async function lastEditedOf(github: ReadClient, repo: Repo, tickets: readonly number[]): Promise<Record<number, ReplayCandidate["lastEdited"]>> {
  const edited: Record<number, ReplayCandidate["lastEdited"]> = {};
  for (let at = 0; at < tickets.length; at += EDITED_PER_QUERY) {
    const chunk = tickets.slice(at, at + EDITED_PER_QUERY);
    const query = [
      "query ($owner: String!, $name: String!) {",
      "  repository(owner: $owner, name: $name) {",
      ...chunk.map((ticket, i) => `    t${i}: issue(number: ${ticket}) { ${EDITED_FIELDS} parent { ${EDITED_FIELDS} } }`),
      "  }",
      "}",
    ].join("\n");
    const data = await github.graphql<{ repository: Record<string, (EditedNode & { parent: EditedNode | null }) | null> }>(query, {
      owner: repo.owner,
      name: repo.name,
    });
    chunk.forEach((ticket, i) => {
      const node = data.repository[`t${i}`] ?? null;
      edited[ticket] = { ticket: node === null ? null : editedAt(node), spec: node?.parent == null ? null : editedAt(node.parent) };
    });
  }
  return edited;
}

/** The later of a body's last edit and a title's last rename, or null for an issue never edited. */
function editedAt({ lastEditedAt, timelineItems }: EditedNode): string | null {
  const times = [lastEditedAt, timelineItems.nodes.at(-1)?.createdAt ?? null].filter((at): at is string => at !== null);
  return times.toSorted((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/** Whether each sha is a commit in the Fabrik repo, which a candidate Kit sha must be. */
async function fabrikCommitsOf(github: ReadClient, shas: readonly string[]): Promise<Record<string, boolean>> {
  return Object.fromEntries(await Promise.all(shas.map(async (sha): Promise<[string, boolean]> => [sha, await isKitCommit(github, sha)])));
}

/** How many commits one query reads the Kit config folder at. */
const SHAS_PER_QUERY = 10;

/** The Kit config folder's files, in the order a query names them. */
const KIT_CONFIG_FILES: readonly string[] = [KIT_CONFIG_PATH, SKILLS_SOURCES_LOCK_PATH, ...INSTRUCTED_ROLES.map(instructionsPath)];

/**
 * The Product repo's Kit config at each sha, resolved under this Kit release
 * as resolveKitConfig resolves it, its skills lock and instructions
 * included, its files read in batches through GraphQL.
 */
async function baseConfigsAt(github: ReadClient, repo: Repo, shas: readonly string[]): Promise<Record<string, BaseKitConfig>> {
  const configs: Record<string, BaseKitConfig> = {};
  for (let at = 0; at < shas.length; at += SHAS_PER_QUERY) {
    const chunk = shas.slice(at, at + SHAS_PER_QUERY);
    const query = [
      "query ($owner: String!, $name: String!) {",
      "  repository(owner: $owner, name: $name) {",
      // Each sha is a full one the plan's reader checked, and each path is the Kit's own.
      ...chunk.flatMap((sha, i) =>
        KIT_CONFIG_FILES.map((path, j) => `    f${i}_${j}: object(expression: ${JSON.stringify(`${sha}:${path}`)}) { ... on Blob { text } }`),
      ),
      "  }",
      "}",
    ].join("\n");
    const data = await github.graphql<{ repository: Record<string, { text?: string | null } | null> }>(query, { owner: repo.owner, name: repo.name });
    chunk.forEach((sha, i) => {
      const text = (j: number) => data.repository[`f${i}_${j}`]?.text ?? null;
      const sources: KitConfigSources = {
        config: text(0),
        skillsLock: text(1),
        instructions: Object.fromEntries(INSTRUCTED_ROLES.map((role, k) => [role, text(k + 2)])),
      };
      configs[sha] = resolveKitConfig(sources);
    });
  }
  return configs;
}
