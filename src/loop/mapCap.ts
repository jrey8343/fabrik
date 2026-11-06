// The Map cap (#154): at most caps.maps Maps open in a Product repo at once,
// so attention stays on one exploration at a time. It counts the open
// `wayfinder:map` issues, whoever made them, the Kit or the Operator by hand,
// and it holds silently: no mention, no assignee. One predicate, so that a
// Design turn landing a Map (src/loop/design.ts), the turn's inputs
// (src/agent/inputs.ts) and the Weekly summary agree on when it's full.
import type { KitConfig } from "./types.ts";

/** Whether the Map cap is full: the open Maps, by number, already meet caps.maps, so no new Map is charted. */
export function mapCapFull(openMaps: readonly number[], config: Pick<KitConfig, "caps">): boolean {
  return openMaps.length >= config.caps.maps;
}

/** The Map cap as a Design turn's landing weighs it: room for a new Map, or full at `cap`, held by these open Maps. */
export type MapCap = { readonly kind: "room" } | { readonly kind: "full"; readonly cap: number; readonly openMaps: readonly number[] };

/** The Map cap over these open Maps, by number, as mapCapFull judges it. */
export function mapCapOf(openMaps: readonly number[], config: Pick<KitConfig, "caps">): MapCap {
  return mapCapFull(openMaps, config) ? { kind: "full", cap: config.caps.maps, openMaps } : { kind: "room" };
}
