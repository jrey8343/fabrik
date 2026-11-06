// The Map cap (#154): at most caps.maps Maps open in a Product repo at once,
// so attention stays on one exploration at a time. It counts the open
// `wayfinder:map` issues, whoever made them, the Kit or the Operator by hand,
// and it holds silently: no mention, no assignee. One predicate, so that a
// Design turn landing a Map (src/loop/design.ts), the turn's inputs
// (src/agent/inputs.ts) and the Weekly summary agree on when it's full.
import type { KitConfig } from "./types.ts";

/** Whether the Map cap is full: the open Maps already meet caps.maps, so no new Map is charted. */
export function mapCapFull(openMaps: readonly unknown[], config: Pick<KitConfig, "caps">): boolean {
  return openMaps.length >= config.caps.maps;
}
