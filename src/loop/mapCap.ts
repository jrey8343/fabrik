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

/**
 * What a Design-session turn on an issue is told of a Map: it may offer one;
 * or the cap is full, at `cap` (0 stops new Maps), and these open Maps hold
 * it; or the issue is a Ticket under the Spec `spec`, which never becomes a
 * Map. Each open Map is as its reader names it.
 */
export type MapOfferOf<OpenMap> =
  | { readonly kind: "may-offer" }
  | { readonly kind: "cap-full"; readonly cap: number; readonly openMaps: readonly OpenMap[] }
  | { readonly kind: "under-a-spec"; readonly spec: number };

/**
 * Whether a Map may be offered on an issue whose parent is `spec` (null for
 * none), with these open Maps: never on a Ticket under a Spec, else while the
 * Map cap has room (mapCapFull), refusing as a Design turn's landing does
 * (src/loop/design.ts). The one predicate the turn's inputs
 * (src/agent/inputs.ts) and the read library's Round read
 * (src/read/roundRead.ts) share, so neither offers a Map the landing would
 * refuse.
 */
export function mapOfferOf<OpenMap extends { readonly number: number }>(
  spec: number | null,
  openMaps: readonly OpenMap[],
  config: Pick<KitConfig, "caps">,
): MapOfferOf<OpenMap> {
  if (spec !== null) return { kind: "under-a-spec", spec };
  return mapCapFull(openMaps.map(({ number }) => number), config) ? { kind: "cap-full", cap: config.caps.maps, openMaps } : { kind: "may-offer" };
}
