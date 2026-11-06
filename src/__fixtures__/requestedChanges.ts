// jrey8343/penrith-physiotherapy-sports-centre#59 (ADR-0010): the Ticket
// lists eight practitioners for Clinical Pilates, the Operator's Request
// changes removed Declan Price, and the PR now lists seven. The Reviewer and
// the retry after it never saw the review, so the retry put him back. This
// is that PR as GitHub serves it to a Review's or a retry's input step.
import type { Reader } from "../agent/inputs.ts";
import { verdictMarker } from "../loop/markers.ts";

export const PENRITH_59_REPO = { owner: "jrey8343", name: "penrith-physiotherapy-sports-centre" } as const;

/** The eight practitioners the Ticket's acceptance criterion lists for Clinical Pilates one on one. */
export const PENRITH_59_TICKET_PRACTITIONERS = ["Amelia Hart", "Ben Ortiz", "Chloe Nguyen", "Declan Price", "Ella Moss", "Finn Walsh", "Grace Lin", "Hugo Reid"];

export const PENRITH_59_REQUEST = "Remove Declan Price as an available provider for clinical pilates one on one";

/** The Verdict the Reviewer gave after the Request-changes run, which the retry fixes. */
export const PENRITH_59_VERDICT = [
  verdictMarker({ verdict: "execution-flaw", source: "reviewer", requestChanges: false, headSha: "d".repeat(40) }),
  "- The Ticket lists eight practitioners for Clinical Pilates, and the PR lists seven: Declan Price is missing.",
].join("\n");

const url = (anchor: string) => `https://github.com/${PENRITH_59_REPO.owner}/${PENRITH_59_REPO.name}/pull/59#${anchor}`;
const operator = { login: "operator", type: "User" };
const bot = { login: "fabrik-app[bot]", type: "Bot" };

/** GitHub as the input step reads PR #59, with the Operator's Request changes and the Reviewer's Verdict after it. */
export function penrith59(): Reader {
  const conversation = [{ id: 1, user: bot, body: PENRITH_59_VERDICT, created_at: "2026-11-02T00:00:00Z", html_url: url("issuecomment-1") }];
  const reviews = [
    { id: 70, user: operator, state: "CHANGES_REQUESTED", body: PENRITH_59_REQUEST, submitted_at: "2026-11-01T00:00:00Z", html_url: url("pullrequestreview-70") },
  ];
  return {
    graphql: async <T>() =>
      ({
        repository: {
          pullRequest: {
            number: 59,
            title: "List the Clinical Pilates practitioners",
            body: `Lists seven practitioners for Clinical Pilates one on one: ${PENRITH_59_TICKET_PRACTITIONERS.filter((name) => name !== "Declan Price").join(", ")}.\n\nCloses #12`,
            baseRefName: "main",
            headRefName: "fabrik/ticket-12",
            headRefOid: "d".repeat(40),
            comments: { nodes: conversation.map(({ body, user }) => ({ body, author: { __typename: user.type } })) },
          },
        },
      }) as T,
    rest: async (_method: string, path: string) => {
      const [route, query] = path.split("?");
      if (!/(^|&)page=1(&|$)/.test(query ?? "")) return [];
      const base = `/repos/${PENRITH_59_REPO.owner}/${PENRITH_59_REPO.name}`;
      if (route === `${base}/issues/59/comments`) return conversation;
      if (route === `${base}/pulls/59/comments`) return [];
      if (route === `${base}/pulls/59/reviews`) return reviews;
      throw new Error(`unexpected REST call ${path}`);
    },
  };
}
