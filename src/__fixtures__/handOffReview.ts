// The review a hand-off's run reads, as GitHub's REST API answers it: review
// 123 on acme/shop's PR #45.

/** A review as GitHub's REST API answers it: a Request changes on PR #45 by `operator`, unless a test says otherwise. */
export function aReview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    node_id: "PRR_kwDO123",
    user: { login: "operator", type: "User" },
    body: "Use the parking copy.",
    state: "CHANGES_REQUESTED",
    html_url: "https://github.com/acme/shop/pull/45#pullrequestreview-123",
    pull_request_url: "https://api.github.com/repos/acme/shop/pulls/45",
    submitted_at: "2026-11-25T03:00:00Z",
    commit_id: "a".repeat(40),
    ...over,
  };
}
