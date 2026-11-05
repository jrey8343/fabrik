// The Kit config: loaded from a Product repo's .fabrik/ folder, with every v1
// default filled in, and validated at the start of every run. Pure, no I/O.

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
    readonly dispatch: { readonly timeoutMinutes: number };
    readonly stepUp: { readonly model: string; readonly effort: string | null };
  };
  /** How many Tickets may be in flight at once; 0 pauses Dispatch. */
  readonly maxInFlight: number;
  /**
   * Attention caps the Operator can only lower below the Kit defaults (#147).
   * Nothing acts on them yet.
   */
  readonly caps: {
    /** How many Design sessions may hold a slot at once; 0 pauses new ones. */
    readonly designSessions: number;
  };
  /** The Operator's GitHub login; null means the Product repo's owner. */
  readonly operator: string | null;
  readonly instructions: Readonly<Record<Phase, string | null>>;
}

export type Phase = "triage" | "design" | "implement" | "review";

export const PHASES: readonly Phase[] = ["triage", "design", "implement", "review"];

/** The raw files the Kit reads from the Kit config folder; null or left out when absent. */
export interface KitConfigSources {
  /** The text of .fabrik/config.json. */
  readonly config: string | null;
  /** The text of each .fabrik/<phase>.md the Product repo provides. */
  readonly instructions?: Readonly<Partial<Record<Phase, string | null>>>;
}

/** Where each optional per-phase instruction file lives in a Product repo. */
export function instructionsPath(phase: Phase): string {
  return `.fabrik/${phase}.md`;
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
    dispatch: { timeoutMinutes: 10 },
    stepUp: { model: OPUS, effort: null },
  },
  maxInFlight: 2,
  caps: { designSessions: 2 },
  operator: null,
  instructions: { triage: null, design: null, implement: null, review: null },
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
  const config = readConfig(new Reader(raw, KIT_CONFIG_PATH, context));
  for (const reader of context.readers) reader.reportUnknownFields();
  const { errors } = context;
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { ...config, instructions: readInstructions(sources.instructions ?? {}) } };
}

function readInstructions(files: NonNullable<KitConfigSources["instructions"]>): KitConfig["instructions"] {
  const instructions: Record<Phase, string | null> = { ...DEFAULT_KIT_CONFIG.instructions };
  for (const phase of PHASES) {
    const text = files[phase];
    if (text !== undefined && text !== null && text.trim() !== "") instructions[phase] = text;
  }
  return instructions;
}

function readConfig(file: Reader): KitConfig {
  const defaults = DEFAULT_KIT_CONFIG;
  const sandbox = file.object("sandbox");
  const roles = file.object("roles");
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
      triage: readAgentRole(roles.object("triage"), defaults.roles.triage),
      design: readAgentRole(roles.object("design"), defaults.roles.design),
      implement: readAgentRole(roles.object("implement"), defaults.roles.implement),
      review: readAgentRole(roles.object("review"), defaults.roles.review),
      dispatch: readDispatch(roles.object("dispatch"), defaults.roles.dispatch),
      stepUp: readStepUp(roles.object("step_up"), defaults.roles.stepUp),
    },
    maxInFlight: file.wholeNumber("max_in_flight", 0) ?? defaults.maxInFlight,
    caps: readCaps(file.object("caps"), defaults.caps),
    operator: orDefault(file.nullableString("operator", checkLogin), defaults.operator),
  };
}

/** A field left out (undefined) takes its default; an explicit null is kept. */
function orDefault<T>(value: T | null | undefined, fallback: T | null): T | null {
  return value === undefined ? fallback : value;
}

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
  return { designSessions: caps.cap("design_sessions", defaults.designSessions) ?? defaults.designSessions };
}

function readStepUp(role: Reader, defaults: KitConfig["roles"]["stepUp"]): KitConfig["roles"]["stepUp"] {
  return {
    model: role.string("model", refuseFable) ?? defaults.model,
    effort: orDefault(role.nullableString("effort", checkEffort), defaults.effort),
  };
}

/**
 * Fable can bill metered usage, so no AFK role may run it, even through an
 * override. `best` is refused too, because the CLI can resolve it to Fable.
 */
function refuseFable(model: string): string | null {
  const name = model.trim().toLowerCase();
  if (name.includes("fable") || name === "best") {
    return "Fable can bill metered usage, so the Kit never runs it in an AFK role";
  }
  return null;
}

/** The Claude Code CLI's --effort levels. */
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

function checkEffort(effort: string): string | null {
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

  /** A string, or null to say "none"; undefined when left out. */
  nullableString(key: string, check?: (value: string) => string | null): string | null | undefined {
    if (Object.hasOwn(this.#value, key) && this.#value[key] === null) {
      this.#take(key);
      return null;
    }
    return this.string(key, check);
  }

  stringList(key: string): readonly string[] | undefined {
    const value = this.#take(key);
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      this.#fail(`${this.#field(key)} must be a list of strings`);
      return undefined;
    }
    return value;
  }

  /** An object of environment variables to strings, each value refused when `check` returns a reason. */
  envMap(key: string, check?: (value: string) => string | null): Readonly<Record<string, string>> | undefined {
    const map = this.object(key);
    if (!Object.hasOwn(this.#value, key)) return undefined;
    const result: Record<string, string> = {};
    for (const name of map.#keys()) {
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

  /** Reports every field in this object that no read asked for. */
  reportUnknownFields(): void {
    for (const key of Object.keys(this.#value)) {
      if (!this.#read.has(key)) this.#fail(`${this.#field(key)} is not a Kit config field`);
    }
  }

  #keys(): readonly string[] {
    return Object.keys(this.#value);
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
