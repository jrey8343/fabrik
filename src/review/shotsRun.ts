// Finding a head's Evidence shots (#820): the newest attempt of the check
// Kit config's ui.shots names at a pull request's head, whatever commit the
// check itself checked out, and the artifact that attempt uploaded. Read
// through GitHub Actions alone, so the review job's token, which already
// holds `actions: read` to download a UI pull request's evidence, needs no
// new permission. The download is the workflow's own step.
import { allPages, type ReadClient, type Repo } from "../github/client.ts";

/** Where a head's Evidence shots are: the workflow run of the named check's newest attempt, and its artifact, or null when it uploaded none. */
export interface ShotsArtifact {
  readonly run: number;
  readonly artifact: number | null;
}

interface WorkflowRun {
  readonly id: number;
}

interface WorkflowJob {
  readonly name: string;
  readonly started_at: string | null;
  readonly run_attempt?: number;
}

interface RunArtifact {
  readonly id: number;
  readonly created_at: string | null;
  readonly expired: boolean;
}

/**
 * The named check's newest attempt at `headSha`, and the artifact of that
 * name it uploaded: among the workflow runs at the head, the latest attempt's
 * job named as the check is, newest by when it started; then the newest
 * unexpired artifact of that name its run holds from that attempt on, so a
 * re-run never reads what an earlier attempt uploaded. Null when no workflow
 * run at the head has the check, as for a check outside GitHub Actions.
 */
export async function findShotsArtifact(
  client: Pick<ReadClient, "rest">,
  repo: Repo,
  { headSha, check, artifact }: { readonly headSha: string; readonly check: string; readonly artifact: string },
): Promise<ShotsArtifact | null> {
  const base = `/repos/${repo.owner}/${repo.name}/actions/runs`;
  const runs = await allPages<WorkflowRun>(client, `${base}?head_sha=${headSha}`, (page) => (page as { workflow_runs: WorkflowRun[] }).workflow_runs);
  let newest: { readonly run: number; readonly startedAt: string } | null = null;
  for (const { id } of runs) {
    const jobs = await allPages<WorkflowJob>(client, `${base}/${id}/jobs?filter=latest`, (page) => (page as { jobs: WorkflowJob[] }).jobs);
    for (const job of jobs) {
      if (job.name !== check || job.started_at === null) continue;
      if (newest === null || Date.parse(job.started_at) > Date.parse(newest.startedAt)) newest = { run: id, startedAt: job.started_at };
    }
  }
  if (newest === null) return null;
  const since = Date.parse(newest.startedAt);
  const artifacts = await allPages<RunArtifact>(client, `${base}/${newest.run}/artifacts?name=${encodeURIComponent(artifact)}`, (page) => (page as { artifacts: RunArtifact[] }).artifacts);
  const uploaded = artifacts.filter((each) => !each.expired && each.created_at !== null && Date.parse(each.created_at) >= since);
  return { run: newest.run, artifact: uploaded.reduce<number | null>((latest, { id }) => (latest === null || id > latest ? id : latest), null) };
}
