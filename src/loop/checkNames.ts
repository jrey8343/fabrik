// How a notice lists check names (src/loop/failures.ts, src/loop/conflicts.ts).

/** Check names as a notice lists them: each in code, joined with commas and a last "and", or "or". */
export function checkNames(names: readonly string[], joiner: "and" | "or" = "and"): string {
  const quoted = names.map((name) => `\`${name.replace(/`/g, "'")}\``);
  const last = quoted.pop();
  return quoted.length === 0 ? (last ?? "") : `${quoted.join(", ")} ${joiner} ${last}`;
}
