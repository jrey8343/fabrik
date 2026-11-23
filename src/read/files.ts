// The files read (#895): several paths of one repo at one commit, in one
// GraphQL query made through the client's own query call, in place of a REST
// request for each. Each path comes back as its text, or as no file, as the
// client's own file read gives it: a path with nothing at it, a directory and
// a submodule are each no file, and a file a query will not give as that
// read does is read singly by it. The gather reads its caller workflow and
// the Kit's files with it (./gather.ts). Read only.
import type { ReadClient, Repo } from "../github/client.ts";

/** Each path asked for, with its text, or null where there is no file. */
export type FilesRead = Readonly<Record<string, string | null>>;

/** The mode GitHub gives a symbolic link among a tree's entries. */
const SYMLINK_MODE = 40960;

/**
 * What a files query gets of one object: a Blob's text, or a Tree's entries,
 * by the fields it asks of each; null for nothing the commit holds there, a
 * submodule among them.
 */
type QueriedObject = {
  readonly __typename: string;
  /** A Blob's text; null for a binary one. */
  readonly text?: string | null;
  readonly isBinary?: boolean;
  readonly isTruncated?: boolean;
  readonly entries?: readonly { readonly name: string; readonly mode: number }[];
} | null;

/**
 * The query for these paths, each under an alias of its own, `file` and its
 * place, and each directory they are in, `tree` and its place, for its
 * entries' modes: one query however many they are, the commit and the paths
 * in its variables.
 */
function filesQuery(files: number, trees: number): string {
  const variables = [
    ...Array.from({ length: files }, (_, at) => `$file${at}: String!`),
    ...Array.from({ length: trees }, (_, at) => `$tree${at}: String!`),
  ];
  return `
  query ($owner: String!, $name: String!, ${variables.join(", ")}) {
    repository(owner: $owner, name: $name) {
${Array.from({ length: files }, (_, at) => `      file${at}: object(expression: $file${at}) { __typename ... on Blob { text isBinary isTruncated } }`).join("\n")}
${Array.from({ length: trees }, (_, at) => `      tree${at}: object(expression: $tree${at}) { __typename ... on Tree { entries { name mode } } }`).join("\n")}
    }
  }
`;
}

/** The directory a path is in, "" at the top of the repo. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * `paths` of `repo` at `ref`, as a file read: one query for them all, and
 * then the client's own file read for each the query gave no text for, or
 * not all of it (a binary file, or one GitHub truncates), and each it found a
 * symbolic link, whose text in a query is the path it points at. A path the
 * query found nothing at, a directory or a submodule (which a query finds no
 * object at) is no file, and is not read again. A path it was not asked
 * about is read singly too. It throws whatever the query throws, a refusal
 * among them, and asks GitHub nothing for no path.
 */
export async function filesAt(client: Pick<ReadClient, "graphql" | "fileText">, repo: Repo, ref: string, paths: readonly string[]): Promise<Pick<ReadClient, "fileText">> {
  const asked = [...new Set(paths)];
  const queried = new Map<string, string | null>();
  if (asked.length > 0) {
    const directories = [...new Set(asked.map(directoryOf))];
    const variables = Object.fromEntries([
      ...asked.map((path, at) => [`file${at}`, `${ref}:${path}`]),
      ...directories.map((directory, at) => [`tree${at}`, `${ref}:${directory}`]),
    ]);
    const { repository } = await client.graphql<{ repository: Record<string, QueriedObject> }>(filesQuery(asked.length, directories.length), {
      owner: repo.owner,
      name: repo.name,
      ...variables,
    });
    const modes = new Map<string, number>();
    directories.forEach((directory, at) => {
      for (const { name, mode } of repository[`tree${at}`]?.entries ?? []) modes.set(directory === "" ? name : `${directory}/${name}`, mode);
    });
    asked.forEach((path, at) => {
      const object = repository[`file${at}`] ?? null;
      const mode = modes.get(path);
      if (object?.__typename !== "Blob") queried.set(path, null);
      // A file its directory shows no entry for is read singly too, as one that might be a link.
      else if (typeof object.text === "string" && object.isBinary !== true && object.isTruncated !== true && mode !== undefined && mode !== SYMLINK_MODE) queried.set(path, object.text);
    });
  }
  return {
    fileText: (at, path, atRef) =>
      at.owner === repo.owner && at.name === repo.name && atRef === ref && queried.has(path) ? Promise.resolve(queried.get(path) ?? null) : client.fileText(at, path, atRef),
  };
}

/**
 * `paths` of `repo` ("owner/name") at `ref`, a commit, each as its text or as
 * no file (null), as the client's file read gives it: one GraphQL query for
 * them all, made through the client's own query call, and a file read, a
 * REST request with the Kit's own client, only for each file GitHub will not
 * give as that read does in a query (filesAt). None at all for no path. It
 * throws a refusal of the query or of a file read, as a file read does.
 */
export async function readFiles(client: Pick<ReadClient, "graphql" | "fileText">, repo: string, ref: string, paths: readonly string[]): Promise<FilesRead> {
  const [owner = "", name = ""] = repo.split("/");
  const at = { owner, name };
  const files = await filesAt(client, at, ref, paths);
  const asked = [...new Set(paths)];
  const texts = await Promise.all(asked.map((path) => files.fileText(at, path, ref)));
  return Object.fromEntries(asked.map((path, index) => [path, texts[index] ?? null]));
}
