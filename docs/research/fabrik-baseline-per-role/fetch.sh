#!/usr/bin/env bash
# Read-only fetch of what baseline.py counts, through the Operator's `gh`.
#
#   fetch.sh OUT
#
# OUT/store      a clone of the run store, jrey8343/fabrik-runs
# OUT/gh         the Pilot's issue/PR timelines, PR reviews, issue and PR
#                lists, Actions runs and their jobs
# OUT/artifacts  the Pilot's Actions artifacts holding each agent run's
#                transcript, agent result and judge result (90-day retention)
#
# Then: python3 -I baseline.py OUT/store OUT/gh OUT/artifacts
# Nothing is written to any repo.
set -u
OUT=$1
REPO=jrey8343/penrith-physiotherapy-sports-centre
mkdir -p "$OUT/gh/tl" "$OUT/gh/reviews" "$OUT/artifacts"

gh repo clone jrey8343/fabrik-runs "$OUT/store" -- --quiet

gh issue list --repo "$REPO" --state all --limit 500 \
  --json number,state,stateReason,createdAt,closedAt,author > "$OUT/gh/issues.json"
gh pr list --repo "$REPO" --state all --limit 500 \
  --json number,state,createdAt,mergedAt,closedAt,author,headRefName > "$OUT/gh/prs.json"
last=$(jq -s '[.[][].number]|max' "$OUT/gh/issues.json" "$OUT/gh/prs.json")
for n in $(seq 1 "$last"); do
  gh api --paginate "repos/$REPO/issues/$n/timeline?per_page=100" > "$OUT/gh/tl/$n.json" 2>/dev/null || rm -f "$OUT/gh/tl/$n.json"
  gh api --paginate "repos/$REPO/pulls/$n/reviews?per_page=100" > "$OUT/gh/reviews/$n.json" 2>/dev/null || rm -f "$OUT/gh/reviews/$n.json"
done

gh api --paginate "repos/$REPO/actions/runs?per_page=100" --jq '.workflow_runs[]' > "$OUT/gh/actions_runs.jsonl"
: > "$OUT/gh/jobs.jsonl"
for id in $(jq -r 'select(.name=="Fabrik" and .conclusion!="skipped")|.id' "$OUT/gh/actions_runs.jsonl"); do
  gh api --paginate "repos/$REPO/actions/runs/$id/jobs?per_page=100&filter=all" \
    --jq '.jobs[]|select(.conclusion!="skipped")|{run_id,run_attempt,name,conclusion,started_at,completed_at}' >> "$OUT/gh/jobs.jsonl"
done

gh api --paginate "repos/$REPO/actions/artifacts?per_page=100" \
  --jq '.artifacts[]|select(.name|test("^fabrik-(transcript|agent-result|judge-result)"))|[.id,.name,.workflow_run.id]|@tsv' |
while IFS=$'\t' read -r id name run; do
  dir="$OUT/artifacts/$run/$name-$id"
  mkdir -p "$dir"
  gh api "repos/$REPO/actions/artifacts/$id/zip" > "$dir/a.zip" && unzip -qo "$dir/a.zip" -d "$dir" && rm "$dir/a.zip"
done
