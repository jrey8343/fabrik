// GitHub and 1Password as the setup program's one run sees them, kept as
// state: what one run creates, a later run finds. Its script answers every gh
// and op command the run makes for acme/clinic, and git runs for real.
import { KIT_ENVIRONMENT } from "../kit/environment.ts";
import type { Ran } from "../setup/exec.ts";
import type { Allowances, BranchProtection } from "../setup/plan.ts";
import { type Answer, type Call, type CannedDeployment, deploymentsOf } from "./setupCommands.ts";

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
  merged?: boolean;
  /** The head's commit when it merged. */
  headRefOid?: string;
  /** The heads a force-push replaced while it was open, as GitHub's "Update with rebase" does, which its timeline keeps. */
  forcePushedFrom?: string[];
}

/** One of a repo's environments, as GitHub holds it. */
export interface WorldEnvironment {
  /** Its `deployment_branch_policy`, as GitHub's GET answers it: null is every branch, as GitHub makes one a workflow names. */
  policy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
  /** Its rules, each with the id GitHub gave it. A PUT of the environment leaves them as they are. */
  rules: { id: number; name: string; type: "branch" | "tag" }[];
  /** Its secrets' names. */
  readonly secrets: Set<string>;
  /** GitHub answers a new rule's POST as taken and keeps no rule, so the rules never read back as the one. */
  dropsNewRules?: boolean;
}

export interface World {
  readonly labels: Set<string>;
  /** The repo-level Actions secrets' names. */
  readonly secrets: Set<string>;
  /** Every repo's environments, each under `environmentKey`. */
  readonly environments: Map<string, WorldEnvironment>;
  /** What GitHub answers a PUT of an environment with when it refuses it, as on a plan that has none, or null when it takes it. */
  environmentRefusal: string | null;
  /** Every gh call that read or changed an environment, its rules or its secrets, as gh was given it, in the order made. */
  readonly environmentCalls: string[];
  readonly vaults: Set<string>;
  /** Each vault's item titles. */
  readonly items: Map<string, Set<string>>;
  /** The default branch's protection, as GitHub's GET answers it, or null when it has none. */
  protection: unknown;
  ruleset: Record<string, unknown> | null;
  readonly prs: PullRequest[];
  /** Label names whose `gh label create` fails, as a partway failure would. */
  readonly failingLabels: Set<string>;
  /** How many open issues are labelled ready-for-agent. */
  readyForAgent: number;
  /** The repo's Deployments, newest first. */
  readonly deployments: CannedDeployment[];
}

export function aWorld(): World {
  return {
    labels: new Set(),
    secrets: new Set(),
    environments: new Map(),
    environmentRefusal: null,
    environmentCalls: [],
    vaults: new Set(),
    items: new Map(),
    protection: null,
    ruleset: null,
    prs: [],
    failingLabels: new Set(),
    readyForAgent: 0,
    deployments: [],
  };
}

/** Stores an item, as the wizard does. */
export function store(world: World, vault: string, title: string): void {
  const items = world.items.get(vault) ?? new Set<string>();
  items.add(title);
  world.items.set(vault, items);
}

/** The repo the world's script answers for, where a call names none. */
const PRODUCT_REPO = "acme/clinic";

/** Where the world keeps a repo's environment. */
export function environmentKey(name: string = KIT_ENVIRONMENT, repo: string = PRODUCT_REPO): string {
  return `${repo}/${name}`;
}

/** A repo's environment as the world holds it, acme/clinic's `fabrik` environment unless told another, or undefined when the repo has none. */
export function environmentOf(world: World, name: string = KIT_ENVIRONMENT, repo: string = PRODUCT_REPO): WorldEnvironment | undefined {
  return world.environments.get(environmentKey(name, repo));
}

/**
 * Puts an environment in the world, acme/clinic's `fabrik` environment unless
 * told another: every branch, with no rule and no secret, as GitHub makes one
 * a workflow names, then the overrides. A rule is given by its name, and by
 * its type when it isn't a branch rule.
 */
export function anEnvironment(
  world: World,
  { policy = null, rules = [], secrets = [] }: { policy?: "all" | "protected" | "selected" | null; rules?: readonly (string | { name: string; type: "branch" | "tag" })[]; secrets?: readonly string[] } = {},
  name: string = KIT_ENVIRONMENT,
  repo: string = PRODUCT_REPO,
): WorldEnvironment {
  const setting = rules.length > 0 ? "selected" : (policy ?? "all");
  const environment: WorldEnvironment = {
    policy: setting === "all" ? null : { protected_branches: setting === "protected", custom_branch_policies: setting === "selected" },
    rules: [],
    secrets: new Set(secrets),
  };
  world.environments.set(environmentKey(name, repo), environment);
  for (const rule of rules) environment.rules.push({ id: nextRuleId(world), ...(typeof rule === "string" ? { name: rule, type: "branch" } : rule) });
  return environment;
}

/** An id no rule in the world has. */
function nextRuleId(world: World): number {
  return Math.max(100, ...[...world.environments.values()].flatMap((environment) => environment.rules.map((rule) => rule.id))) + 1;
}

const NOT_FOUND = { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: "gh: Not Found (HTTP 404)" };

/** `gh api`'s method and path: an environment, its rules, or one rule by its id. */
const ENVIRONMENT_PATH = /^repos\/([^/]+\/[^/]+)\/environments\/([^/?]+)(\/deployment-branch-policies(?:\?per_page=100|\/(\d+))?)?$/;

/**
 * GitHub's answer to a `gh api` call on an environment, as #846 saw it answer
 * the Operator's gh, or null when the call isn't one. Each call is recorded
 * in the world's environmentCalls.
 */
function environmentAnswer(world: World, { args, input, line }: Call): Partial<Ran> | null {
  const method = args[1] === "--method" ? (args[2] ?? "") : "GET";
  const rest = method === "GET" ? args.slice(1) : args.slice(3);
  const matched = ENVIRONMENT_PATH.exec(rest[0] ?? "");
  if (matched === null) return null;
  world.environmentCalls.push(line);
  const [, repo, name, rules, ruleId] = matched;
  const key = environmentKey(name, repo);
  const environment = world.environments.get(key);
  if (rules === undefined) {
    if (method === "PUT") {
      if (world.environmentRefusal !== null) return { code: 1, stderr: world.environmentRefusal };
      // Makes it, or sets which refs it lets through: its rules and its secrets are untouched.
      const { deployment_branch_policy: policy = null } = JSON.parse(input ?? "{}") as { deployment_branch_policy?: WorldEnvironment["policy"] };
      if (environment === undefined) world.environments.set(key, { policy, rules: [], secrets: new Set() });
      else environment.policy = policy;
      return json({ name, deployment_branch_policy: policy });
    }
    if (method !== "GET") throw new Error(`The world has no answer for: ${line}`);
    return environment === undefined ? NOT_FOUND : json({ id: 1, name, protection_rules: [], deployment_branch_policy: environment.policy });
  }
  if (environment === undefined) return NOT_FOUND;
  if (method === "GET" && ruleId === undefined) return json({ total_count: environment.rules.length, branch_policies: environment.rules });
  if (method === "POST" && ruleId === undefined) {
    const field = (key: string) => rest.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
    const rule = { name: field("name"), type: field("type") === "tag" ? ("tag" as const) : ("branch" as const) };
    // The same POST a second time is taken, and still leaves one rule.
    const has = environment.rules.some((existing) => existing.name === rule.name && existing.type === rule.type);
    if (!has && environment.dropsNewRules !== true) environment.rules.push({ id: nextRuleId(world), ...rule });
    return json(rule);
  }
  if (method === "DELETE" && ruleId !== undefined) {
    if (!environment.rules.some((rule) => String(rule.id) === ruleId)) return NOT_FOUND;
    environment.rules = environment.rules.filter((rule) => String(rule.id) !== ruleId);
    return {};
  }
  throw new Error(`The world has no answer for: ${line}`);
}

/** A protection as a PUT wrote it, in the shape GitHub's GET answers with: each switch an `{ enabled }`, each allowance an object. */
function asGitHubReadsIt(put: BranchProtection): Record<string, unknown> {
  const people = (allowances: Allowances) => ({
    users: allowances.users.map((login) => ({ login })),
    teams: allowances.teams.map((slug) => ({ slug })),
    apps: allowances.apps.map((slug) => ({ slug })),
  });
  const checks = put.required_status_checks;
  const reviews = put.required_pull_request_reviews;
  const { required_status_checks: _checks, required_pull_request_reviews: _reviews, restrictions, ...switches } = put;
  return {
    ...Object.fromEntries(Object.entries(switches).map(([name, enabled]) => [name, { enabled }])),
    ...(checks === null
      ? {}
      : {
          required_status_checks: {
            strict: checks.strict,
            contexts: checks.checks.map((check) => check.context),
            checks: checks.checks.map((check) => ({ context: check.context, app_id: check.app_id ?? null })),
          },
        }),
    ...(reviews === null
      ? {}
      : {
          required_pull_request_reviews: {
            ...reviews,
            ...(reviews.dismissal_restrictions === undefined ? {} : { dismissal_restrictions: people(reviews.dismissal_restrictions) }),
            ...(reviews.bypass_pull_request_allowances === undefined
              ? {}
              : { bypass_pull_request_allowances: people(reviews.bypass_pull_request_allowances) }),
          },
        }),
    ...(restrictions === null ? {} : { restrictions: people(restrictions) }),
  };
}

const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
const names = (set: Set<string>) => json([...set].map((name) => ({ name })));
const valueOf = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";

/** What GitHub reads from the repo's own git. */
export interface Origin {
  /** How many commits a head has that a base lacks. */
  commitsAhead(base: string, head: string): number;
  /** How a head stands to a base, as GitHub's compare sums it up ("ahead", "identical", "behind" or "diverged"), or null when either isn't there. */
  compare?(base: string, head: string): string | null;
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
    // An environment's secrets, by name: the checkout's repo's, or with --repo another's.
    "gh secret list --env": ({ args, line }) => {
      world.environmentCalls.push(line);
      const environment = environmentOf(world, valueOf(args, "--env"), args.includes("--repo") ? valueOf(args, "--repo") : PRODUCT_REPO);
      return environment === undefined ? { code: 1, stderr: "failed to get secrets: HTTP 404: Not Found" } : names(environment.secrets);
    },
    // The ready Operator's script answers this one line too, so the world answers it by name.
    [`gh api repos/${PRODUCT_REPO}/environments/${KIT_ENVIRONMENT}`]: (call) => environmentAnswer(world, call) ?? {},
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
      world.protection = asGitHubReadsIt(JSON.parse(input ?? "{}") as BranchProtection);
      return {};
    },
    "gh api repos/acme/clinic/rulesets?includes_parents=false": () => json(world.ruleset === null ? [] : [{ id: 1, name: world.ruleset["name"] }]),
    "gh api repos/acme/clinic/rulesets/1": () => json(world.ruleset),
    "gh api --method POST repos/acme/clinic/rulesets": ({ input }) => {
      world.ruleset = { id: 1, ...(JSON.parse(input ?? "{}") as Record<string, unknown>) };
      return {};
    },
    // The compare's two commits follow its endpoint with no space, so no longer key can name it, and so do the Deployments' query and id.
    // An environment's calls name any repo and any environment, so they are answered here too.
    "gh api": (call) => {
      const { args } = call;
      const environment = environmentAnswer(world, call);
      if (environment !== null) return environment;
      const deployed = deploymentsOf("acme/clinic", world.deployments)[call.line];
      if (deployed !== undefined) return typeof deployed === "function" ? deployed(call) : deployed;
      const compared = /^repos\/acme\/clinic\/compare\/(\w+)\.\.\.(\w+)$/.exec(args[1] ?? "");
      if (compared === null || origin?.compare === undefined) throw new Error(`The world has no answer for: gh ${args.join(" ")}`);
      const status = origin.compare(compared[1]!, compared[2]!);
      return status === null ? { code: 1, stderr: "gh: Not Found (HTTP 404)" } : { stdout: `${status}\n` };
    },
    // A PR's force-pushes, as its timeline's HeadRefForcePushedEvents give them.
    "gh api graphql": ({ args }) => {
      if (!args.some((arg) => arg.startsWith("query=") && arg.includes("HEAD_REF_FORCE_PUSHED_EVENT"))) {
        throw new Error(`The world has no answer for: gh ${args.join(" ")}`);
      }
      const pr = world.prs.find((candidate) => `number=${candidate.number}` === valueOf(args, "-F"));
      const nodes = (pr?.forcePushedFrom ?? []).map((oid) => ({ beforeCommit: { oid } }));
      return json({ data: { repository: { pullRequest: pr === undefined ? null : { timelineItems: { nodes } } } } });
    },
    "gh pr list": ({ args }) =>
      json(
        world.prs
          .filter((pr) => (valueOf(args, "--state") === "merged" ? pr.merged === true : pr.open) && pr.head === valueOf(args, "--head"))
          .map(({ number, url, body, isCrossRepository, headRefOid }) => ({ number, url, body, isCrossRepository, headRefOid })),
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
