// The Kit config: loaded from a Product repo's .fabrik/ folder, with every v1
// default filled in, and validated at the start of every run. Pure, no I/O.
import { knownTimeZone, spelled } from "../loop/readable.ts";
import { AGENT_ROLES, type AgentRole as AgentRoleName } from "../loop/types.ts";
import { FULL_SHA, REPOSITORY } from "../skills/lock.ts";

export interface AgentRole {
  readonly model: string;
  /** null means pass no --effort, so the Claude Code CLI uses its default. */
  readonly effort: string | null;
  readonly timeoutMinutes: number;
}

export interface KitConfig {
  readonly sandbox: {
    readonly setup: string | null;
    readonly build: string | null;
    readonly test: string | null;
    readonly checks: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly roles: {
    readonly triage: AgentRole;
    readonly design: AgentRole;
    readonly implement: AgentRole;
    readonly review: AgentRole;
    /** The Auditor; it takes no Extra skills (ADR-0008). */
    readonly audit: AgentRole;
    /** The Retro; it takes no Extra skills (ADR-0008). */
    readonly retro: AgentRole;
    /** The Researcher; it takes no Extra skills (ADR-0008). */
    readonly research: AgentRole;
    /**
     * The Digest writer (ADR-0022); it takes no Extra skills (ADR-0008). Left
     * out, its model and effort are this repo's own `roles.review`.
     */
    readonly digest: AgentRole;
    readonly dispatch: { readonly timeoutMinutes: number };
    readonly stepUp: { readonly model: string; readonly effort: string | null };
  };
  /** How many Tickets and research Decisions may be in flight at once; 0 pauses Dispatch. PRs at the Merge gate fall under caps.mergeGate. */
  readonly maxInFlight: number;
  /** Attention caps the Operator can only lower below the Kit defaults (#147). */
  readonly caps: {
    /** How many Design sessions may hold a slot at once; 0 pauses new ones. */
    readonly designSessions: number;
    /** How many open error issues the Monitor keeps at once; 0 pauses new error filings (#148). */
    readonly monitorIssues: number;
    /** How many open Maps the repo may have at once, whoever charted them; 0 stops new Maps (#154). */
    readonly maps: number;
    /**
     * How many agent PRs may wait on the Operator at the Merge gate, those on
     * their way to it counted (#459, ADR-0023): Dispatch releases a Ticket only
     * if its PR could fit. 0 holds Tickets while any is at or on its way.
     */
    readonly mergeGate: number;
  };
  /** What the Monitor watches in this Product repo (#148). */
  readonly monitor: {
    /** Where the Monitor reads production errors; null leaves them off. */
    readonly errors: MonitorErrors | null;
    /** Whether the Monitor files an issue while the default branch's CI is red. */
    readonly redMain: boolean;
  };
  readonly audit: {
    /** The UTC day of the week the Audit runs; null turns the Audit off. */
    readonly day: AuditDay | null;
  };
  readonly retro: {
    /** The UTC day of the week the Retro runs; null turns the Retro off. */
    readonly day: RetroDay | null;
  };
  readonly digest: {
    /** Whether the Kit writes Digests in this repo; false has a pass open the Merge gate itself, and declines `agent:digest`. */
    readonly enabled: boolean;
  };
  /** The Operator's GitHub login; null means the Product repo's owner. */
  readonly operator: string | null;
  /**
   * The Subscriptions the Kit runs agents on, in the order it uses them: each
   * the name of a `Fabrik` vault item holding that Subscription's token.
   */
  readonly subscriptions: readonly string[];
  /** Each role's own instructions from .fabrik/<role>.md, the Auditor's, the Retro's, the Researcher's and the Digest writer's included. */
  readonly instructions: Readonly<Record<InstructedRole, string | null>>;
  /** The Product repo's own Skills sources, from .fabrik/skills.lock.json. */
  readonly skillsSources: readonly SkillsSource[];
  /** Each role's Extra skills, picked from those sources; a Step-up run uses implement's. */
  readonly extraSkills: Readonly<Record<Phase, readonly ExtraSkill[]>>;
  /** What makes a pull request UI and how the Sandbox serves it for UI evidence (#153); null never captures. */
  readonly ui: UiConfig | null;
  /** Where a pull request's preview deployment appears (#153); null links none. */
  readonly preview: PreviewConfig | null;
  /** Where the Product repo's production is (ADR-0021); null declares nothing, and nothing in the Loop reads it. */
  readonly production: ProductionConfig | null;
  /**
   * The Operator's time zone (ADR-0023), an IANA zone every time the Kit shows
   * the Operator is written in; null, as when `time_zone` is unset or names no
   * zone the runtime knows (timeZoneNote), writes them in UTC.
   */
  readonly timeZone: string | null;
}

/** The `ui` block: which changed files make a pull request UI, and how the Sandbox serves the branch to capture it. */
export interface UiConfig {
  /** Globs of the files whose change makes a pull request UI; never empty. */
  readonly paths: readonly string[];
  /** The command the Sandbox runs in the background after `sandbox.build` to serve the branch. */
  readonly serve: string;
  /** The local base URL the Kit polls until it answers, then captures routes under. */
  readonly url: string;
  /** The production base URL Before is captured from; null skips Before. */
  readonly beforeUrl: string | null;
  /** The routes captured when neither the Ticket nor the Implementer names any, each starting with `/`. */
  readonly defaultRoutes: readonly string[];
  /**
   * Each Capture identity (ADR-0012) and the command that signs it in to the
   * Sandbox's own server, writing a Playwright storage state; never empty.
   * Absent, capture signs nothing in, and the next two fields are absent too.
   */
  readonly signIn?: Readonly<Record<CaptureIdentity, string>>;
  /** The route the app sends a signed-out visitor to; set whenever `signIn` is. */
  readonly signInPath?: string;
  /** Which Capture identity views each route, the first rule to match winning; set, and never empty, whenever `signIn` is. */
  readonly signedInRoutes?: readonly SignedInRoute[];
}

/** A named kind of user that UI evidence views a route as: one of `ui.sign_in`'s keys. */
export type CaptureIdentity = string;

/** One of `ui.signed_in_routes`: the routes its pattern matches are viewed as `as`, or signed out when it's null. */
export interface SignedInRoute {
  /** A route pattern: `*` matches within one path segment, `**` across segments. */
  readonly route: string;
  readonly as: CaptureIdentity | null;
}

/** A Capture identity's name: letters, digits, `-` and `_`, starting with a letter or digit, so it reads plainly wherever it's named. */
const CAPTURE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Whether a value is a Capture identity's name, as `ui.sign_in` keys it and the capture result records it. */
export function isCaptureIdentity(value: unknown): value is CaptureIdentity {
  return typeof value === "string" && CAPTURE_IDENTITY.test(value);
}

/**
 * The Capture identity a route is viewed as, or null when it's viewed signed
 * out: the `as` of the first of `ui.signed_in_routes` whose pattern matches
 * the route's path, its query and fragment left out, and null when none
 * matches or Kit config signs nothing in.
 */
export function captureIdentityOf(route: string, ui: UiConfig): CaptureIdentity | null {
  const path = route.replace(/[?#].*$/s, "");
  return ui.signedInRoutes?.find((rule) => routePattern(rule.route).test(path))?.as ?? null;
}

/**
 * A route pattern as a regular expression over a whole path: `*` matches
 * within one segment, `**` across any number of them, and a `/**` segment
 * matches none too, so `/**` matches `/` and `/console/**` matches `/console`.
 */
function routePattern(pattern: string): RegExp {
  const source = pattern
    .split(/(\/\*\*(?=\/|$)|\*\*|\*)/)
    .map((part) => {
      if (part === "/**") return "(?:/.*)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "s");
}

/**
 * Whether a value is a route: a path on the site captured under `ui.url`,
 * starting with exactly one `/`, since `//host/...` would leave it for another
 * host. Kit config's `ui.default_routes`, the Implementer's routes, a Ticket's
 * and the capture result's are all routes by this one rule.
 */
export function isRoute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

/** A browser viewport UI evidence is captured at. */
export interface Viewport {
  readonly name: "mobile" | "desktop";
  readonly width: number;
  readonly height: number;
}

/**
 * The viewports UI evidence is captured at, mobile first: a Kit constant, not
 * Kit config, so every Product repo's evidence covers phones and desktops alike.
 */
export const UI_VIEWPORTS: readonly Viewport[] = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
];

/**
 * The most routes UI evidence captures, so capture stays fast: a Kit constant,
 * not Kit config. A route the Ticket names is captured even past it.
 */
export const UI_ROUTE_CAP = 4;

/**
 * The most UI evidence images a Reviewer gets, so the ones that matter most fit
 * in its context: a Kit constant, not Kit config. The Operator's Evidence page is uncapped.
 */
export const REVIEWER_IMAGE_CAP = 8;

/** The `preview` block: a URL template the Kit fills in and polls, never calling a host's API. */
export interface PreviewConfig {
  /** An http(s) URL that may use only the PREVIEW_PLACEHOLDERS, such as `https://pr-{pr}.example.dev`. */
  readonly url: string;
}

/**
 * The `production` block: the production site's address and the name its
 * deploys carry in GitHub's Deployments. Only a reader of the Kit acts on it;
 * the Loop still ends at the merge.
 */
export interface ProductionConfig {
  /** The production site's http(s) base address, which live links are built from. */
  readonly url: string;
  /** The environment the repo's production deploys carry in GitHub's Deployments; null when its host reports none. */
  readonly environment: string | null;
}

/** The placeholders a `preview.url` template may use, filled in from the pull request after the push. */
export const PREVIEW_PLACEHOLDERS = ["pr", "branch_slug", "sha"] as const;

export type PreviewPlaceholder = (typeof PREVIEW_PLACEHOLDERS)[number];

/** A pull request whose preview deployment the Kit links, as its push left it: what fills each placeholder in. */
export interface PreviewOf {
  readonly number: number;
  /** Its head branch, such as fabrik/ticket-12. */
  readonly branch: string;
  /** The commit the push left that branch at. */
  readonly headSha: string;
}

/**
 * The pull request's preview deployment: `template` with `{pr}` its number,
 * `{branch_slug}` its branch's slug and `{sha}` its full head commit, written
 * out as a parsed URL, so it is one line that can't break out of a link. So
 * the agent branch fabrik/ticket-12 is fabrik-ticket-12, a name that fits in
 * a hostname, as hosts name a branch's preview. The Kit never shortens it,
 * though a host may shorten a long one.
 */
export function previewUrl(template: string, { number, branch, headSha }: PreviewOf): string {
  const url = URL.parse(fillPlaceholders(template, { pr: String(number), branch_slug: slug(branch), sha: headSha }));
  if (url === null) throw new Error(`The preview.url template ${template} doesn't fill in to a URL`);
  return url.href;
}

/** Whether the template names the pull request, as `{pr}`: one a branch with no PR, such as a Prototype's, can't fill in. */
export function previewNamesPullRequest(template: string): boolean {
  return [...template.matchAll(PLACEHOLDER)].some(([, name]) => name === "pr");
}

/** A Prototype's branch as its push left it, and the route its variants render on: what fills its preview in. */
export interface PrototypePreviewOf {
  /** prototype/<issue>. */
  readonly branch: string;
  /** The commit the push left that branch at. */
  readonly headSha: string;
  /** A path starting with `/`, which may hold a query. */
  readonly route: string;
}

/**
 * A Prototype's preview of its route: `template` filled in as a pull
 * request's, `{branch_slug}` the branch's slug and `{sha}` its head, with the
 * route on its path, as capture puts it on `ui.url` (src/evidence/capture.ts).
 * A prototype has no PR, so a template that names one fills in to nothing.
 * The route is set as the URL's path, so whatever it holds, it stays on the
 * preview's host.
 */
export function prototypePreviewUrl(template: string, { branch, headSha, route }: PrototypePreviewOf): string {
  if (previewNamesPullRequest(template)) throw new Error(`The preview.url template ${template} names the pull request, which a prototype hasn't got`);
  const url = URL.parse(fillPlaceholders(template, { pr: "", branch_slug: slug(branch), sha: headSha }));
  if (url === null) throw new Error(`The preview.url template ${template} doesn't fill in to a URL`);
  return withRouteOn(url.href, route);
}

/**
 * The page at `route` on the site served at `base`, an http(s) address: the
 * route on the base's own path, with no doubled slash where they meet, and a
 * query in the route kept beside any the base has. The route is set as the
 * URL's path, so whatever it holds, the page stays on the base's host. A
 * Prototype's preview, a pull request's preview pages and the live pages
 * after a merge are all built so (#639). Throws when `base` is no URL.
 */
export function withRouteOn(base: string, route: string): string {
  const url = URL.parse(base);
  if (url === null) throw new Error(`${base} is not a URL`);
  const at = route.indexOf("?");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${at === -1 ? route : route.slice(0, at)}`;
  if (at !== -1) for (const [name, value] of new URLSearchParams(route.slice(at + 1))) url.searchParams.append(name, value);
  return url.href;
}

/** The page at `route` on the production site the `production` block declares, as a reader links it once a pull request is merged. */
export function productionPageUrl(production: ProductionConfig, route: string): string {
  return withRouteOn(production.url, route);
}

/**
 * The text as a slug: in lower case, with each run of characters other than a
 * letter or a digit (a to z, 0 to 9) made one `-`, and no `-` at either end.
 * A preview's `{branch_slug}` is its branch's, and a screenshot's file name
 * holds its route's (src/evidence/capture.ts).
 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The Sentry project the Monitor reads a Product repo's production errors from. */
export interface MonitorErrors {
  readonly provider: "sentry";
  /** The Sentry organization's slug. */
  readonly org: string;
  /** The Sentry project's slug. */
  readonly project: string;
  /** The Sentry host: sentry.io, another Sentry region, or a Sentry-compatible host. */
  readonly url: string;
  /** How many events in 24 hours an `error` group needs before it's filed; a `fatal` one needs none. */
  readonly minEvents: number;
}

/** A Skills source a Product repo pins: a public repository at one commit. */
export interface SkillsSource {
  /** `owner/name` on GitHub. */
  readonly repository: string;
  /** A full 40-character lowercase commit SHA. */
  readonly sha: string;
}

/** One skill picked for a role from a pinned Skills source. */
export interface ExtraSkill {
  /** The source's repository, `owner/name`, as the lockfile spells it. */
  readonly source: string;
  /** The name the skill installs as under .claude/skills/. */
  readonly name: string;
}

/** The UTC days of the ISO week, Monday first, that a weekly run is due from. */
export const WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export type WeekDay = (typeof WEEK_DAYS)[number];

/** The Audit runs on one of the UTC days of the week. */
export const AUDIT_DAYS = WEEK_DAYS;

export type AuditDay = WeekDay;

/** The Retro runs on one of the same UTC days of the week as the Audit. */
export const RETRO_DAYS = WEEK_DAYS;

export type RetroDay = WeekDay;

export type Phase = "triage" | "design" | "implement" | "review";

export const PHASES: readonly Phase[] = ["triage", "design", "implement", "review"];

/** Whether an AFK role is a Phase, and so takes Extra skills: the Auditor, the Retro, the Researcher and the Digest writer take none (ADR-0008). */
export function isPhase(role: AgentRoleName): role is Phase {
  return (PHASES as readonly AgentRoleName[]).includes(role);
}

/**
 * The roles a Product repo can give its own instructions in .fabrik/<role>.md:
 * every AFK role, so every Phase, the Auditor, the Retro, the Researcher and
 * the Digest writer, which take no Extra skills (ADR-0008) and so are no Phase.
 */
export type InstructedRole = AgentRoleName;

export const INSTRUCTED_ROLES: readonly InstructedRole[] = AGENT_ROLES;

/** Every Extra skill the given roles pick, each once however many of them pick it. */
export function picksIn(config: KitConfig, roles: readonly Phase[] = PHASES): readonly ExtraSkill[] {
  const picks = new Map<string, ExtraSkill>();
  for (const role of roles) {
    for (const pick of config.extraSkills[role]) picks.set(`${pick.source}/${pick.name}`, pick);
  }
  return [...picks.values()];
}

/** The raw files the Kit reads from the Kit config folder; null or left out when absent. */
export interface KitConfigSources {
  /** The text of .fabrik/config.json. */
  readonly config: string | null;
  /** The text of each .fabrik/<role>.md the Product repo provides. */
  readonly instructions?: Readonly<Partial<Record<InstructedRole, string | null>>>;
  /** The text of .fabrik/skills.lock.json. */
  readonly skillsLock?: string | null;
}

/** Where each optional per-role instruction file lives in a Product repo. */
export function instructionsPath(role: InstructedRole): string {
  return `.fabrik/${role}.md`;
}

export type KitConfigResult =
  | { readonly ok: true; readonly config: KitConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

export const DEFAULT_KIT_CONFIG: KitConfig = {
  sandbox: { setup: null, build: null, test: null, checks: [], env: {}, secrets: {} },
  roles: {
    triage: { model: OPUS, effort: null, timeoutMinutes: 10 },
    design: { model: OPUS, effort: null, timeoutMinutes: 30 },
    implement: { model: SONNET, effort: null, timeoutMinutes: 60 },
    review: { model: OPUS, effort: null, timeoutMinutes: 30 },
    audit: { model: OPUS, effort: null, timeoutMinutes: 45 },
    retro: { model: OPUS, effort: null, timeoutMinutes: 45 },
    research: { model: OPUS, effort: null, timeoutMinutes: 30 },
    // The Reviewer's model and effort, which a repo's own roles.review replaces (readConfig).
    digest: { model: OPUS, effort: null, timeoutMinutes: 10 },
    dispatch: { timeoutMinutes: 10 },
    stepUp: { model: OPUS, effort: null },
  },
  maxInFlight: 2,
  caps: { designSessions: 2, monitorIssues: 5, maps: 1, mergeGate: 3 },
  monitor: { errors: null, redMain: true },
  // Sunday, so a fresh Audit is open by Monday's Weekly summary and misses the Monday skills bump.
  audit: { day: "sunday" },
  // Saturday, a day before the Audit's Sunday, so the two frontier runs never share an
  // hour and both are open by Monday's Weekly summary.
  retro: { day: "saturday" },
  digest: { enabled: true },
  operator: null,
  // The V1 vault item, so a repo that lists none keeps the one Subscription it always ran on.
  subscriptions: ["Claude token"],
  instructions: { triage: null, design: null, implement: null, review: null, audit: null, retro: null, research: null, digest: null },
  skillsSources: [],
  extraSkills: { triage: [], design: [], implement: [], review: [] },
  // Visual evidence is off until a Product repo turns it on with /fabrik-visual-evidence.
  ui: null,
  preview: null,
  // Production is declared by a Product repo, never guessed.
  production: null,
  // UTC until the Operator gives their time zone, as Setup writes it.
  timeZone: null,
};

/** Where the Kit config lives in a Product repo (ADR-0005). */
export const KIT_CONFIG_PATH = ".fabrik/config.json";

/** Fills in every default the file leaves out, or says what's wrong with it. */
export function resolveKitConfig(sources: KitConfigSources): KitConfigResult {
  const text = sources.config ?? "";
  let raw: unknown = {};
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return { ok: false, errors: [`${KIT_CONFIG_PATH} is not valid JSON: ${(error as Error).message}`] };
    }
  }
  const context: ReadContext = { errors: [], readers: [] };
  const picks: Picks = {};
  const config = readConfig(new Reader(raw, KIT_CONFIG_PATH, context), picks);
  const skills = readSkills(picks, sources.skillsLock ?? null, context);
  for (const reader of context.readers) reader.reportUnknownFields();
  const { errors } = context;
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { ...config, ...skills, instructions: readInstructions(sources.instructions ?? {}) } };
}

/**
 * Whether the Kit config folder asks for Extra skills at all: it has a Skills
 * sources lockfile, or some role in config.json gives a `skills` key. A repo
 * that doesn't is untouched by Extra skills, even when its Kit config is
 * invalid for some other reason.
 */
export function asksForExtraSkills(sources: Pick<KitConfigSources, "config" | "skillsLock">): boolean {
  if (sources.skillsLock !== null && sources.skillsLock !== undefined) return true;
  let raw: unknown;
  try {
    raw = JSON.parse(sources.config ?? "");
  } catch {
    return false;
  }
  const roles = (raw as { roles?: unknown } | null)?.roles;
  if (typeof roles !== "object" || roles === null) return false;
  return Object.values(roles).some((role) => typeof role === "object" && role !== null && Object.hasOwn(role, "skills"));
}

/** Each pickable role's raw `skills` list, as the Kit config gives it; null when it isn't a list of strings. */
type Picks = Partial<Record<Phase, readonly string[] | null>>;

type Skills = Pick<KitConfig, "skillsSources" | "extraSkills">;

/** Where a Product repo pins its own Skills sources (ADR-0008). */
export const SKILLS_SOURCES_LOCK_PATH = ".fabrik/skills.lock.json";

/**
 * Reads the Skills sources lockfile and checks each pickable role's picks
 * against it: every pick names a pinned source, every pin is picked from, and
 * no two sources give a skill the same name. Checking a pick against the
 * source's own manifest needs the network, so it happens elsewhere.
 */
function readSkills(picks: Picks, lockText: string | null, context: ReadContext): Skills {
  const errorsBefore = context.errors.length;
  const skillsSources = readSkillsSources(lockText, context);
  // A pick against a lockfile that failed to read would only add noise.
  const lockRead = context.errors.length === errorsBefore;
  let picksRead = PHASES.every((phase) => picks[phase] !== null);
  const pinned = new Map(skillsSources.map((source) => [source.repository.toLowerCase(), source.repository]));
  const pickedFrom = new Set<string>();
  const named = new Map<string, { readonly field: string; readonly source: string }>();
  const extraSkills: Record<Phase, readonly ExtraSkill[]> = { ...DEFAULT_KIT_CONFIG.extraSkills };
  for (const phase of PHASES) {
    const role: ExtraSkill[] = [];
    const pickedAt = new Map<string, string>();
    (picks[phase] ?? []).forEach((pick, i) => {
      const field = `roles.${phase}.skills[${i}]`;
      const fail = (reason: string) => {
        picksRead = false;
        context.errors.push(`${field} is ${JSON.stringify(pick)}: ${reason}`);
      };
      const parsed = PICK.exec(pick);
      if (parsed === null || parsed[2] === "." || parsed[2] === "..") return fail("a pick must be owner/name/skill");
      const [, repository = "", name = ""] = parsed;
      const source = pinned.get(repository.toLowerCase());
      if (source === undefined) {
        if (lockRead) fail(`${repository} has no pin in ${SKILLS_SOURCES_LOCK_PATH}`);
        return;
      }
      pickedFrom.add(source.toLowerCase());
      const key = `${source.toLowerCase()}/${name}`;
      const twice = pickedAt.get(key);
      if (twice !== undefined) return fail(`${twice} already picks it`);
      pickedAt.set(key, field);
      const clash = named.get(name);
      if (clash !== undefined && clash.source !== source) {
        return fail(`${clash.field} already picks a skill named ${name} from ${clash.source}`);
      }
      if (clash === undefined) named.set(name, { field, source });
      role.push({ source, name });
    });
    extraSkills[phase] = role;
  }
  // A pick that failed to read may be the one meant for a pin that looks unused.
  if (lockRead && picksRead) {
    skillsSources.forEach((source, i) => {
      if (!pickedFrom.has(source.repository.toLowerCase())) {
        context.errors.push(
          `${SKILLS_SOURCES_LOCK_PATH}[${i}] pins ${source.repository}, but no role picks a skill from it`,
        );
      }
    });
  }
  return { skillsSources, extraSkills };
}

/** `owner/name/skill`: a pinned source's repository, then the name the skill installs as. */
const PICK = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** The pins in the Skills sources lockfile; an empty or absent file pins none. */
function readSkillsSources(text: string | null, context: ReadContext): readonly SkillsSource[] {
  if (text === null || text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    context.errors.push(`${SKILLS_SOURCES_LOCK_PATH} is not valid JSON: ${(error as Error).message}`);
    return [];
  }
  if (!Array.isArray(raw)) {
    context.errors.push(`${SKILLS_SOURCES_LOCK_PATH} must be a list of { repository, sha } pins`);
    return [];
  }
  const sources: SkillsSource[] = [];
  const pinnedAt = new Map<string, string>();
  raw.forEach((value: unknown, i) => {
    const entry = `${SKILLS_SOURCES_LOCK_PATH}[${i}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      context.errors.push(`${entry} must be an object`);
      return;
    }
    const pin = new Reader(value, entry, context);
    const repository = pin.requiredString("repository", checkRepository);
    const sha = pin.requiredString("sha", checkSha);
    if (repository === undefined || sha === undefined) return;
    const earlier = pinnedAt.get(repository.toLowerCase());
    if (earlier !== undefined) {
      context.errors.push(`${entry} pins ${repository}, which ${earlier} already pins`);
      return;
    }
    pinnedAt.set(repository.toLowerCase(), entry);
    sources.push({ repository, sha });
  });
  return sources;
}

function checkRepository(repository: string): string | null {
  return REPOSITORY.test(repository) ? null : "a repository must be owner/name";
}

function checkSha(sha: string): string | null {
  return FULL_SHA.test(sha) ? null : "a pin must be a full 40-character lowercase commit SHA";
}

function readInstructions(files: NonNullable<KitConfigSources["instructions"]>): KitConfig["instructions"] {
  const instructions: Record<InstructedRole, string | null> = { ...DEFAULT_KIT_CONFIG.instructions };
  for (const role of INSTRUCTED_ROLES) {
    const text = files[role];
    if (text !== undefined && text !== null && text.trim() !== "") instructions[role] = text;
  }
  return instructions;
}

/** Reads config.json, collecting each pickable role's `skills` into `picks`. */
function readConfig(file: Reader, picks: Picks): Omit<KitConfig, keyof Skills> {
  const defaults = DEFAULT_KIT_CONFIG;
  const sandbox = file.object("sandbox");
  const roles = file.object("roles");
  const review = readPickingRole(roles.object("review"), defaults.roles.review, picks, "review");
  return {
    ...defaults,
    sandbox: {
      setup: orDefault(sandbox.nullableString("setup"), defaults.sandbox.setup),
      build: orDefault(sandbox.nullableString("build"), defaults.sandbox.build),
      test: orDefault(sandbox.nullableString("test"), defaults.sandbox.test),
      checks: sandbox.stringList("checks") ?? defaults.sandbox.checks,
      env: sandbox.envMap("env") ?? defaults.sandbox.env,
      secrets: sandbox.envMap("secrets", requireOpReference) ?? defaults.sandbox.secrets,
    },
    roles: {
      triage: readPickingRole(roles.object("triage"), defaults.roles.triage, picks, "triage"),
      design: readPickingRole(roles.object("design"), defaults.roles.design, picks, "design"),
      implement: readPickingRole(roles.object("implement"), defaults.roles.implement, picks, "implement"),
      review,
      audit: readAgentRole(roles.object("audit"), defaults.roles.audit),
      retro: readAgentRole(roles.object("retro"), defaults.roles.retro),
      research: readAgentRole(roles.object("research"), defaults.roles.research),
      // The Digest writer runs on this repo's Reviewer's model and effort unless it sets its own, within its own time limit.
      digest: readAgentRole(roles.object("digest"), { ...review, timeoutMinutes: defaults.roles.digest.timeoutMinutes }),
      dispatch: readDispatch(roles.object("dispatch"), defaults.roles.dispatch),
      stepUp: readStepUp(roles.object("step_up"), defaults.roles.stepUp),
    },
    maxInFlight: file.wholeNumber("max_in_flight", 0) ?? defaults.maxInFlight,
    caps: readCaps(file.object("caps"), defaults.caps),
    monitor: readMonitor(file.object("monitor"), defaults.monitor),
    audit: readAudit(file.object("audit"), defaults.audit),
    retro: readRetro(file.object("retro"), defaults.retro),
    digest: { enabled: file.object("digest").boolean("enabled") ?? defaults.digest.enabled },
    operator: orDefault(file.nullableString("operator", checkLogin), defaults.operator),
    subscriptions: file.subscriptions("subscriptions") ?? defaults.subscriptions,
    ui: readUi(file.nullableObject("ui")),
    preview: readPreview(file.nullableObject("preview")),
    production: readProduction(file.nullableObject("production")),
    // A time_zone the runtime doesn't know falls back to UTC, and never fails the Kit config (ADR-0023).
    timeZone: knownTimeZone(file.unchecked("time_zone")),
  };
}

/**
 * The step summary's one line for a `time_zone` that names no IANA zone the
 * runtime knows, naming it, or null when it's unset, a zone, or the Kit
 * config isn't a JSON object, whose errors say so instead.
 */
export function timeZoneNote(configText: string | null): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(configText ?? "");
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)["time_zone"];
  if (value === undefined || value === null || knownTimeZone(value) !== null) return null;
  return `\`time_zone\` in ${KIT_CONFIG_PATH} is ${JSON.stringify(value)}, which isn't an IANA time zone, such as Europe/London, so the Kit writes its times in UTC.`;
}

/** A field left out (undefined) takes its default; an explicit null is kept. */
function orDefault<T>(value: T | null | undefined, fallback: T | null): T | null {
  return value === undefined ? fallback : value;
}

/** A role that takes Extra skill picks (ADR-0008), collecting its `skills` into `picks`. */
function readPickingRole(role: Reader, defaults: AgentRole, picks: Picks, phase: Phase): AgentRole {
  const skills = role.stringList("skills");
  if (skills !== undefined) picks[phase] = skills;
  else if (role.has("skills")) picks[phase] = null;
  return readAgentRole(role, defaults);
}

/** An AFK role's model, effort and timeout. A role that doesn't read `skills` refuses it as unknown. */
function readAgentRole(role: Reader, defaults: AgentRole): AgentRole {
  return {
    model: role.string("model", refuseFable) ?? defaults.model,
    effort: orDefault(role.nullableString("effort", checkEffort), defaults.effort),
    timeoutMinutes: role.positiveInteger("timeout_minutes") ?? defaults.timeoutMinutes,
  };
}

function readDispatch(role: Reader, defaults: KitConfig["roles"]["dispatch"]): KitConfig["roles"]["dispatch"] {
  return { timeoutMinutes: role.positiveInteger("timeout_minutes") ?? defaults.timeoutMinutes };
}

/**
 * Every cap goes through the tighten-only reader, so a repo can lower its
 * attention budget but never raise it (#147). The Monitor and Ideas and Maps
 * Specs register their caps here.
 */
function readCaps(caps: Reader, defaults: KitConfig["caps"]): KitConfig["caps"] {
  return {
    designSessions: caps.cap("design_sessions", defaults.designSessions) ?? defaults.designSessions,
    monitorIssues: caps.cap("monitor_issues", defaults.monitorIssues) ?? defaults.monitorIssues,
    maps: caps.cap("maps", defaults.maps) ?? defaults.maps,
    mergeGate: caps.cap("merge_gate", defaults.mergeGate) ?? defaults.mergeGate,
  };
}

function readMonitor(monitor: Reader, defaults: KitConfig["monitor"]): KitConfig["monitor"] {
  const errors = monitor.nullableObject("errors");
  return {
    errors: errors === undefined ? defaults.errors : errors === null ? null : readMonitorErrors(errors),
    redMain: monitor.boolean("red_main") ?? defaults.redMain,
  };
}

/** Where `monitor.errors` points when it leaves these out. */
const MONITOR_ERRORS_DEFAULTS = { url: "https://sentry.io", minEvents: 3 } as const;

function readMonitorErrors(errors: Reader): MonitorErrors | null {
  const provider = errors.requiredString("provider", checkErrorProvider);
  const org = errors.requiredString("org", checkSentrySlug);
  const project = errors.requiredString("project", checkSentrySlug);
  const url = errors.string("url", checkHttpsUrl) ?? MONITOR_ERRORS_DEFAULTS.url;
  const minEvents = errors.positiveInteger("min_events") ?? MONITOR_ERRORS_DEFAULTS.minEvents;
  if (provider === undefined || org === undefined || project === undefined) return null;
  return { provider: "sentry", org, project, url, minEvents };
}

/** GlitchTip and other Sentry-compatible hosts are reached through `url`, not a provider of their own. */
function checkErrorProvider(provider: string): string | null {
  return provider === "sentry" ? null : "the only provider is sentry; point url at a Sentry-compatible host";
}

/** A Sentry organization or project slug, as it appears in the Sentry URL; it goes into API paths as it is. */
const SENTRY_SLUG = /^[a-z0-9_-]+$/;

function checkSentrySlug(slug: string): string | null {
  return SENTRY_SLUG.test(slug) ? null : "a Sentry slug is lowercase letters, digits, hyphens and underscores";
}

function checkHttpsUrl(url: string): string | null {
  return URL.parse(url)?.protocol === "https:" ? null : "the Sentry token is sent there, so it must be an https:// URL";
}

/** The `ui` block; left out or null, Visual evidence never captures. */
function readUi(ui: Reader | null | undefined): UiConfig | null {
  if (ui === undefined || ui === null) return null;
  const paths = ui.requiredList("paths", "list at least one glob of the files that make a pull request UI", checkGlob);
  const serve = ui.requiredString("serve", checkServe);
  const url = ui.requiredString("url", checkHttpOrHttpsUrl);
  const beforeUrl = ui.nullableString("before_url", checkHttpOrHttpsUrl);
  const defaultRoutes = ui.stringList("default_routes", checkRoute);
  const signedIn = readSignIn(ui, url);
  if (paths === undefined || serve === undefined || url === undefined || signedIn === undefined) return null;
  return { paths, serve, url, beforeUrl: beforeUrl ?? null, defaultRoutes: defaultRoutes ?? [], ...signedIn };
}

/** The `ui` block's sign-in fields, which only come together. */
const SIGNED_IN_FIELDS = ["sign_in_path", "signed_in_routes"] as const;

/**
 * The `ui` block's sign-in fields (ADR-0012): none when it sets none, else
 * all three, with `ui.url` a loopback address; undefined once it has named
 * every problem.
 */
function readSignIn(ui: Reader, url: string | undefined): Pick<UiConfig, "signIn" | "signInPath" | "signedInRoutes"> | undefined {
  const signIn = ui.nullableObject("sign_in");
  if (signIn === undefined || signIn === null) {
    const given = SIGNED_IN_FIELDS.filter((key) => ui.has(key));
    ui.skip(...given);
    // A sign_in that isn't an object has already been named, which is all the others need.
    if (signIn === undefined && ui.has("sign_in")) return undefined;
    for (const key of given) {
      ui.refuse(`${ui.fieldName(key)} is set, but ${ui.fieldName("sign_in")} isn't: name a sign-in command for each Capture identity`);
    }
    return given.length === 0 ? {} : undefined;
  }
  const identities = signIn.keys();
  const commands = signIn.stringMap(
    "is not a Capture identity name: letters, digits, - and _, starting with a letter or digit",
    isCaptureIdentity,
    checkSignInCommand,
  );
  if (identities.length === 0) ui.refuse(`${ui.fieldName("sign_in")} is empty: name at least one Capture identity and the command that signs it in`);
  const path = ui.has("sign_in_path")
    ? ui.string("sign_in_path", checkRoute)
    : ui.refuse(`${ui.fieldName("sign_in_path")} is missing: with ${ui.fieldName("sign_in")}, name the route the app sends a signed-out visitor to`);
  const rules = readSignedInRoutes(ui, identities);
  const loopback = url === undefined || isLoopback(url);
  if (!loopback) {
    ui.refuse(
      `${ui.fieldName("url")} is ${JSON.stringify(url)}: a ui with sign_in serves on a loopback address, such as http://localhost:4321, so a sign-in only ever reaches the Sandbox's own server`,
    );
  }
  if (commands === undefined || identities.length === 0 || path === undefined || rules === undefined || !loopback) return undefined;
  return { signIn: commands, signInPath: path, signedInRoutes: rules };
}

/**
 * `ui.signed_in_routes`: an ordered, non-empty list of rules, each `as` null
 * or one of `identities`; undefined once its problems are named. With no
 * identity to name, only `ui.sign_in` being empty is named.
 */
function readSignedInRoutes(ui: Reader, identities: readonly string[]): readonly SignedInRoute[] | undefined {
  const field = ui.fieldName("signed_in_routes");
  const which = `with ${ui.fieldName("sign_in")}, list which Capture identity views each route`;
  if (!ui.has("signed_in_routes")) return ui.refuse(`${field} is missing: ${which}`);
  const rules = ui.objectList("signed_in_routes", "a list of { route, as } rules");
  if (rules === undefined) return undefined;
  if (rules.length === 0) return ui.refuse(`${field} is empty: ${which}`);
  const read = rules.map((rule): SignedInRoute | undefined => {
    if (rule === null) return undefined;
    const route = rule.requiredString("route", checkRoute);
    if (!rule.has("as")) {
      rule.skip("as");
      return rule.refuse(`${rule.fieldName("as")} is missing: name a ${ui.fieldName("sign_in")} identity, or null for a public route`);
    }
    const as = rule.nullableString("as", (name) =>
      identities.length === 0 || identities.includes(name) ? null : `it must be null or one of ${ui.fieldName("sign_in")}'s identities, ${spelled(identities)}`,
    );
    return route === undefined || as === undefined ? undefined : { route, as };
  });
  return read.every((rule) => rule !== undefined) ? read : undefined;
}

function checkSignInCommand(command: string): string | null {
  return command.trim() === "" ? "a sign-in command can't be blank" : null;
}

/** Whether a URL's host is this machine's loopback: localhost, a name under .localhost, 127.0.0.1 or [::1]. */
function isLoopback(url: string): boolean {
  const host = URL.parse(url)?.hostname.toLowerCase();
  if (host === undefined) return false;
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

function checkGlob(glob: string): string | null {
  return glob.trim() === "" ? "a glob can't be blank" : null;
}

function checkServe(command: string): string | null {
  return command.trim() === "" ? "the command that serves the branch can't be blank" : null;
}

function checkRoute(route: string): string | null {
  return isRoute(route) ? null : "a route must be a path starting with one /, such as /book";
}

function checkHttpOrHttpsUrl(url: string): string | null {
  const protocol = URL.parse(url)?.protocol;
  return protocol === "http:" || protocol === "https:" ? null : "a URL must start with http:// or https://";
}

/** The `preview` block; left out, null, or with no `url`, the pull request links no preview. */
function readPreview(preview: Reader | null | undefined): PreviewConfig | null {
  if (preview === undefined || preview === null) return null;
  const url = preview.nullableString("url", checkPreviewTemplate);
  return url === undefined || url === null ? null : { url };
}

/** The `production` block; left out or null, it declares nothing. */
function readProduction(production: Reader | null | undefined): ProductionConfig | null {
  if (production === undefined || production === null) return null;
  const url = production.requiredString("url", checkHttpOrHttpsUrl);
  const environment = production.nullableString("environment", checkEnvironment);
  if (url === undefined) return null;
  return { url, environment: environment ?? null };
}

function checkEnvironment(environment: string): string | null {
  if (environment.trim() === "") return "an environment can't be blank";
  return /[\r\n]/.test(environment) ? "an environment is the one line GitHub's Deployments name it" : null;
}

/** A stand-in for each placeholder, so a template can be checked as the URL it fills in to. */
const PLACEHOLDER_STAND_INS: Readonly<Record<PreviewPlaceholder, string>> = {
  pr: "1",
  branch_slug: "branch",
  sha: "0".repeat(40),
};

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The template with each placeholder filled in; one that isn't a placeholder stays as it is. */
function fillPlaceholders(template: string, values: Readonly<Record<PreviewPlaceholder, string>>): string {
  return template.replace(PLACEHOLDER, (token, name: string) => (isPreviewPlaceholder(name) ? values[name] : token));
}

function isPreviewPlaceholder(name: string): name is PreviewPlaceholder {
  return (PREVIEW_PLACEHOLDERS as readonly string[]).includes(name);
}

function checkPreviewTemplate(template: string): string | null {
  const only = `a preview URL may use only ${spelled(PREVIEW_PLACEHOLDERS.map((name) => `{${name}}`), "and")}`;
  const unknown = [...template.matchAll(PLACEHOLDER)].filter(([, name = ""]) => !isPreviewPlaceholder(name));
  if (unknown.length > 0) {
    const tokens = spelled(unknown.map(([token]) => token), "and");
    return `${tokens} ${unknown.length === 1 ? "is not a placeholder" : "are not placeholders"}; ${only}`;
  }
  const filled = fillPlaceholders(template, PLACEHOLDER_STAND_INS);
  if (/[{}]/.test(filled)) return `it has a { or } that isn't part of a placeholder; ${only}`;
  return checkHttpOrHttpsUrl(filled);
}

function readAudit(audit: Reader, defaults: KitConfig["audit"]): KitConfig["audit"] {
  // checkAuditDay refuses anything but a day, so the string is an AuditDay.
  const day = audit.nullableString("day", checkAuditDay) as AuditDay | null | undefined;
  return { day: orDefault(day, defaults.day) };
}

function checkAuditDay(day: string): string | null {
  if ((AUDIT_DAYS as readonly string[]).includes(day)) return null;
  return `the Audit day must be one of ${AUDIT_DAYS.join(", ")}, or null to turn the Audit off`;
}

function readRetro(retro: Reader, defaults: KitConfig["retro"]): KitConfig["retro"] {
  // checkRetroDay refuses anything but a day, so the string is a RetroDay.
  const day = retro.nullableString("day", checkRetroDay) as RetroDay | null | undefined;
  return { day: orDefault(day, defaults.day) };
}

function checkRetroDay(day: string): string | null {
  if ((RETRO_DAYS as readonly string[]).includes(day)) return null;
  return `the Retro day must be one of ${RETRO_DAYS.join(", ")}, or null to turn the Retro off`;
}

function readStepUp(role: Reader, defaults: KitConfig["roles"]["stepUp"]): KitConfig["roles"]["stepUp"] {
  return {
    model: role.string("model", refuseFable) ?? defaults.model,
    effort: orDefault(role.nullableString("effort", checkEffort), defaults.effort),
  };
}

/**
 * Why an AFK role may not run `model`, or null when it may. Fable can bill
 * metered usage, so no AFK role may run it, even through an override. `best`
 * is refused too, because the CLI can resolve it to Fable. A Replay's
 * variable model is held to it too (src/kit/replayRequest.ts).
 */
export function refuseFable(model: string): string | null {
  const name = model.trim().toLowerCase();
  if (name.includes("fable") || name === "best") {
    return "Fable can bill metered usage, so the Kit never runs it in an AFK role";
  }
  return null;
}

/** The Claude Code CLI's --effort levels. */
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Why `effort` isn't one of the CLI's --effort levels, or null when it is. A Replay's variable effort is held to it too. */
export function checkEffort(effort: string): string | null {
  return EFFORTS.includes(effort) ? null : `effort must be one of ${EFFORTS.join(", ")}`;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function checkLogin(login: string): string | null {
  return LOGIN.test(login) ? null : "the Operator must be a GitHub login, such as octocat (no @)";
}

function requireOpReference(value: string): string | null {
  return value.startsWith("op://") ? null : "a test secret must be an op:// reference, never the secret itself";
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names the Kit, Claude Code, 1Password or Actions own. A Sandbox value or
 * test secret by one of these names could replace the Claude token, open a
 * metered-billing route, or confuse the runner, so none may be set.
 */
const RESERVED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OP_", "GITHUB_", "ACTIONS_", "RUNNER_", "FABRIK_"];

function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === "PATH" || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Every Reader over one file, so fields nobody read can be reported once reading is done. */
interface ReadContext {
  readonly errors: string[];
  readonly readers: Reader[];
}

/** Reads one JSON object, recording an error that names the field for anything it can't use. */
class Reader {
  readonly #value: Record<string, unknown>;
  readonly #path: string;
  readonly #context: ReadContext;
  readonly #read = new Set<string>();

  constructor(value: unknown, path: string, context: ReadContext) {
    this.#path = path;
    this.#context = context;
    context.readers.push(this);
    if (value === undefined) {
      this.#value = {};
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      this.#value = value as Record<string, unknown>;
    } else {
      this.#value = {};
      this.#fail(`${path} must be an object`);
    }
  }

  object(key: string): Reader {
    return new Reader(this.#take(key), this.#field(key), this.#context);
  }

  /** A string, refused when `check` returns a reason. */
  string(key: string, check?: (value: string) => string | null): string | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      this.#fail(`${this.#field(key)} must be a string`);
      return undefined;
    }
    const refusal = check?.(value) ?? null;
    if (refusal !== null) {
      this.#fail(`${this.#field(key)} is ${JSON.stringify(value)}: ${refusal}`);
      return undefined;
    }
    return value;
  }

  /** A string that must be there, refused when `check` returns a reason. */
  requiredString(key: string, check?: (value: string) => string | null): string | undefined {
    if (!Object.hasOwn(this.#value, key)) {
      this.#take(key);
      this.#fail(`${this.#field(key)} is missing`);
      return undefined;
    }
    return this.string(key, check);
  }

  positiveInteger(key: string): number | undefined {
    return this.wholeNumber(key, 1);
  }

  /** A whole number no smaller than `min`. */
  wholeNumber(key: string, min: number): number | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
      this.#fail(`${this.#field(key)} must be a whole number of at least ${min}`);
      return undefined;
    }
    return value;
  }

  /** A whole number from 0 up to `kitDefault`: a cap can only be lowered (#147). */
  cap(key: string, kitDefault: number): number | undefined {
    const value = this.wholeNumber(key, 0);
    if (value === undefined || value <= kitDefault) return value;
    this.#fail(`${this.#field(key)} is ${value}, but a cap can only be lowered: the Kit default is ${kitDefault}`);
    return undefined;
  }

  /** An object, or null to say "none"; undefined when left out or not an object. */
  nullableObject(key: string): Reader | null | undefined {
    const value = this.#take(key);
    if (value === undefined || value === null) return value;
    if (typeof value !== "object" || Array.isArray(value)) {
      this.#fail(`${this.#field(key)} must be an object or null`);
      return undefined;
    }
    return new Reader(value, this.#field(key), this.#context);
  }

  boolean(key: string): boolean | undefined {
    const value = this.#take(key);
    if (value === undefined || typeof value === "boolean") return value;
    this.#fail(`${this.#field(key)} must be true or false`);
    return undefined;
  }

  /** A string, or null to say "none"; undefined when left out. */
  nullableString(key: string, check?: (value: string) => string | null): string | null | undefined {
    if (Object.hasOwn(this.#value, key) && this.#value[key] === null) {
      this.#take(key);
      return null;
    }
    return this.string(key, check);
  }

  /** A list of strings, each refused, by its place in the list, when `check` returns a reason. */
  stringList(key: string, check?: (value: string) => string | null): readonly string[] | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      this.#fail(`${this.#field(key)} must be a list of strings`);
      return undefined;
    }
    let refused = false;
    value.forEach((item, i) => {
      const refusal = check?.(item) ?? null;
      if (refusal === null) return;
      refused = true;
      this.#fail(`${this.#field(key)}[${i}] is ${JSON.stringify(item)}: ${refusal}`);
    });
    return refused ? undefined : value;
  }

  /** A list of strings that must be there and hold at least one; `empty` says what to list. */
  requiredList(key: string, empty: string, check?: (value: string) => string | null): readonly string[] | undefined {
    if (!Object.hasOwn(this.#value, key)) {
      this.#take(key);
      this.#fail(`${this.#field(key)} is missing`);
      return undefined;
    }
    const list = this.stringList(key, check);
    if (list === undefined || list.length > 0) return list;
    this.#fail(`${this.#field(key)} is empty: ${empty}`);
    return undefined;
  }

  /** The Subscriptions: an ordered, non-empty list of distinct `Fabrik` vault item names. */
  subscriptions(key: string): readonly string[] | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    const field = this.#field(key);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
      this.#fail(`${field} must be a list of Fabrik vault item names`);
      return undefined;
    }
    if (value.length === 0) {
      this.#fail(`${field} is empty: list at least one Subscription`);
      return undefined;
    }
    // Each name goes into the Kit job's GITHUB_OUTPUT and an op://Fabrik/<name>/credential reference.
    const unsafe = value.find((name) => /[\u0000-\u001f\u007f/]/u.test(name));
    if (unsafe !== undefined) {
      this.#fail(
        `${field} names ${JSON.stringify(unsafe)}, but a Fabrik vault item name can't hold a control character or a slash`,
      );
      return undefined;
    }
    const repeated = value.find((name, i) => value.indexOf(name) !== i);
    if (repeated !== undefined) {
      this.#fail(`${field} lists ${JSON.stringify(repeated)} more than once`);
      return undefined;
    }
    return value;
  }

  /** An object of environment variables to strings, each value refused when `check` returns a reason. */
  envMap(key: string, check?: (value: string) => string | null): Readonly<Record<string, string>> | undefined {
    const map = this.object(key);
    if (!Object.hasOwn(this.#value, key)) return undefined;
    const result: Record<string, string> = {};
    for (const name of map.keys()) {
      if (!ENV_NAME.test(name)) {
        map.#take(name);
        this.#fail(`${map.#field(name)} is not a valid environment variable name`);
        continue;
      }
      if (isReservedEnvName(name)) {
        map.#take(name);
        this.#fail(`${map.#field(name)} is reserved for the Kit, so the Sandbox can't set it`);
        continue;
      }
      const value = map.string(name, check);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }

  /**
   * A list of objects, a Reader over each, or null in place of one that isn't
   * an object, once it's named; `what` says what the list must be.
   */
  objectList(key: string, what: string): readonly (Reader | null)[] | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.#fail(`${this.#field(key)} must be ${what}`);
      return undefined;
    }
    return value.map((item: unknown, i) => {
      const at = `${this.#field(key)}[${i}]`;
      if (typeof item === "object" && item !== null && !Array.isArray(item)) return new Reader(item, at, this.#context);
      this.#fail(`${at} must be an object`);
      return null;
    });
  }

  /**
   * This object as a map of names to strings, each name refused with `badName`
   * unless `isName` takes it, each value refused when `check` returns a
   * reason; undefined once any is refused.
   */
  stringMap(badName: string, isName: (name: string) => boolean, check: (value: string) => string | null): Readonly<Record<string, string>> | undefined {
    const result: Record<string, string> = {};
    let refused = false;
    for (const name of this.keys()) {
      if (!isName(name)) {
        this.#take(name);
        this.#fail(`${this.#field(name)} ${badName}`);
        refused = true;
        continue;
      }
      const value = this.string(name, check);
      if (value === undefined) refused = true;
      else result[name] = value;
    }
    return refused ? undefined : result;
  }

  /** Whatever this object gives for `key`, unchecked: for a field whose bad value falls back rather than fails. */
  unchecked(key: string): unknown {
    return this.#take(key);
  }

  /** Whether this object gives `key` at all. */
  has(key: string): boolean {
    return Object.hasOwn(this.#value, key);
  }

  /** Marks these fields read without reading them, as when a problem elsewhere already says why they can't be used. */
  skip(...keys: readonly string[]): void {
    for (const key of keys) this.#take(key);
  }

  /** Names a problem the reads here don't, always giving undefined, for whoever reads on. */
  refuse(message: string): undefined {
    this.#fail(message);
    return undefined;
  }

  /** A field's name as errors spell it. */
  fieldName(key: string): string {
    return this.#field(key);
  }

  /** The keys this object gives. */
  keys(): readonly string[] {
    return Object.keys(this.#value);
  }

  /** Reports every field in this object that no read asked for. */
  reportUnknownFields(): void {
    for (const key of Object.keys(this.#value)) {
      if (!this.#read.has(key)) this.#fail(`${this.#field(key)} is not a Kit config field`);
    }
  }

  #take(key: string): unknown {
    this.#read.add(key);
    return Object.hasOwn(this.#value, key) ? this.#value[key] : undefined;
  }

  #fail(message: string): void {
    this.#context.errors.push(message);
  }

  #field(key: string): string {
    return this.#path === KIT_CONFIG_PATH ? key : `${this.#path}.${key}`;
  }
}
