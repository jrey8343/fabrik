// GitHub and 1Password as the setup program's one run sees them, kept as
// state: what one run creates, a later run finds. Its script answers every gh
// and op command the run makes for acme/clinic, and git runs for real.
import type { Answer } from "./setupCommands.ts";

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  /** The head branch's name, which a fork's PR can share with one of the repo's own. */
  readonly head: string;
  readonly base: string;
  /** Whether its head is in a fork, not in acme/clinic. */
  readonly isCrossRepository: boolean;
  body: string;
  open: boolean;
}

export interface World {
  readonly labels: Set<string>;
  readonly secrets: Set<string>;
  readonly vaults: Set<string>;
  /** Each vault's item titles. */
  readonly items: Map<string, Set<string>>;
  protection: unknown;
  ruleset: Record<string, unknown> | null;
  readonly prs: PullRequest[];
  /** Label names whose `gh label create` fails, as a partway failure would. */
  readonly failingLabels: Set<string>;
  /** How many open issues are labelled ready-for-agent. */
  readyForAgent: number;
}

export function aWorld(): World {
  return {
    labels: new Set(),
    secrets: new Set(),
    vaults: new Set(),
    items: new Map(),
    protection: null,
    ruleset: null,
    prs: [],
    failingLabels: new Set(),
    readyForAgent: 0,
  };
}

/** Stores an item, as the wizard does. */
export function store(world: World, vault: string, title: string): void {
  const items = world.items.get(vault) ?? new Set<string>();
  items.add(title);
  world.items.set(vault, items);
}

const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
const names = (set: Set<string>) => json([...set].map((name) => ({ name })));
const valueOf = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";

/** What GitHub reads from the repo's own git: how many commits a head has that a base lacks. */
export interface Origin {
  commitsAhead(base: string, head: string): number;
}

export function worldScript(world: World, origin?: Origin): Record<string, Answer> {
  return {
    "gh label list --limit 1000 --json name": () => names(world.labels),
    "gh label create": ({ args }) => {
      if (world.failingLabels.has(args[2]!)) return { code: 1, stderr: `HTTP 502: creating ${args[2]} failed` };
      world.labels.add(args[2]!);
      return {};
    },
    "gh issue list": () => json(Array.from({ length: world.readyForAgent }, (_, i) => ({ number: i + 1 }))),
    "gh secret list --json name": () => names(world.secrets),
    "gh secret set": ({ args }) => {
      world.secrets.add(args[2]!);
      return {};
    },
    "op vault list --format json": () => names(world.vaults),
    "op vault create": ({ args }) => {
      world.vaults.add(args.slice(2).join(" "));
      return {};
    },
    "op item list": ({ args }) => {
      const vault = valueOf(args, "--vault");
      if (!world.vaults.has(vault)) return { code: 1, stderr: `"${vault}" isn't a vault in this account` };
      return json([...(world.items.get(vault) ?? [])].map((title) => ({ title })));
    },
    "op service-account create": { stdout: "ops_token\n" },
    "gh api repos/acme/clinic/branches/main/protection": () =>
      world.protection === null ? { code: 1, stderr: "gh: Branch not protected (HTTP 404)" } : json(world.protection),
    "gh api --method PUT repos/acme/clinic/branches/main/protection": ({ input }) => {
      world.protection = JSON.parse(input ?? "{}");
      return {};
    },
    "gh api repos/acme/clinic/rulesets?includes_parents=false": () => json(world.ruleset === null ? [] : [{ id: 1, name: world.ruleset["name"] }]),
    "gh api repos/acme/clinic/rulesets/1": () => json(world.ruleset),
    "gh api --method POST repos/acme/clinic/rulesets": ({ input }) => {
      world.ruleset = { id: 1, ...(JSON.parse(input ?? "{}") as Record<string, unknown>) };
      return {};
    },
    "gh pr list": ({ args }) =>
      json(
        world.prs
          .filter((pr) => pr.open && pr.head === valueOf(args, "--head"))
          .map(({ number, url, body, isCrossRepository }) => ({ number, url, body, isCrossRepository })),
      ),
    "gh pr create": ({ args, input }) => {
      const [base, head] = [valueOf(args, "--base"), valueOf(args, "--head")];
      if (origin !== undefined && origin.commitsAhead(base, head) === 0) {
        return { code: 1, stderr: `pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)` };
      }
      const number = world.prs.length + 1;
      const url = `https://github.com/acme/clinic/pull/${number}`;
      world.prs.push({ number, url, head: valueOf(args, "--head"), base: valueOf(args, "--base"), isCrossRepository: false, body: input ?? "", open: true });
      return { stdout: `${url}\n` };
    },
    "gh pr edit": ({ args, input }) => {
      const pr = world.prs.find((candidate) => String(candidate.number) === args[2]);
      if (pr === undefined) return { code: 1, stderr: `no pull request ${args[2]}` };
      pr.body = input ?? "";
      return {};
    },
  };
}
