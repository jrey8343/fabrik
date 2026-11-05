// Where Run records and the Weekly summary live (ADR-0009): one private repo
// shared by every Product repo. A Kit constant, like the Kit's own repo, not a
// Kit config field.
export const RUN_STORE = { owner: "jrey8343", name: "fabrik-runs" } as const;

/** The store as `owner/name`. */
export const RUN_STORE_REPO = `${RUN_STORE.owner}/${RUN_STORE.name}`;
