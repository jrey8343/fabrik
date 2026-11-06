// The Map cap (caps.maps, #154): how many Maps may be open in a Product repo
// at once. One rule for every reader of it, so the Map landing's check and
// the Weekly summary's Held line can't disagree.
import { MAP_LABEL } from "./labels.ts";
import type { KitConfig } from "./types.ts";

/** Whether an issue is a Map: it has the `wayfinder:map` label, whoever charted it, the Kit or the Operator by hand. */
export function isMap({ labels }: { readonly labels: readonly string[] }): boolean {
  return labels.includes(MAP_LABEL);
}

/** Whether this many open Maps fill the Map cap, so no other Map may land. A cap of 0 is full with none open. */
export function mapCapFull(openMaps: number, config: Pick<KitConfig, "caps">): boolean {
  return openMaps >= config.caps.maps;
}
