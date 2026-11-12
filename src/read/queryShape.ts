// The shape GitHub charges for (#529): GitHub prices a GraphQL query by the
// connections it asks for, each multiplied by the page sizes of the
// connections it sits in, so a connection inside a connection inside a
// connection is what made one page of the Weekly summary's gather cost 25
// points. No query of the gather shaped for Home (./gather.ts) has one; its
// test holds that by reading each query's text with this. Pure, no I/O.

/** A selection set being read: the field that opened it, and whether that field is a connection. */
interface Frame {
  readonly field: string;
  readonly connection: boolean;
}

/** A field's arguments that ask for a page: `first:` or `last:`, never a variable named so. */
const PAGE_SIZE = /(?<![$\w])(?:first|last)\s*:/;

/**
 * Every connection in `query` that sits inside two others, by its path of
 * connections, such as `pullRequests > reviews > comments`, in the order they
 * appear. A connection is a field asked for with `first:` or `last:`; a field
 * with no page, an inline fragment and a selection like `nodes` are none.
 */
export function threeDeepConnectionsIn(query: string): string[] {
  const found: string[] = [];
  const stack: Frame[] = [];
  let field = "";
  let args = "";
  let at = 0;
  while (at < query.length) {
    const char = query[at] ?? "";
    if (char === '"') {
      at = query.indexOf('"', at + 1) + 1 || query.length;
    } else if (char === "#") {
      at = query.indexOf("\n", at) + 1 || query.length;
    } else if (/[A-Za-z_]/.test(char)) {
      const name = /^[A-Za-z_]\w*/.exec(query.slice(at))?.[0] ?? char;
      field = name;
      args = "";
      at += name.length;
    } else if (char === "(") {
      const close = closingOf(query, at);
      args = query.slice(at + 1, close);
      at = close + 1;
    } else if (char === "{") {
      const connection = PAGE_SIZE.test(args);
      if (connection) {
        const path = [...stack.filter((frame) => frame.connection).map((frame) => frame.field), field];
        if (path.length >= 3) found.push(path.join(" > "));
      }
      stack.push({ field, connection });
      field = "";
      args = "";
      at += 1;
    } else if (char === "}") {
      stack.pop();
      field = "";
      args = "";
      at += 1;
    } else {
      at += 1;
    }
  }
  return found;
}

/** Where the parenthesis opened at `open` closes, strings in it skipped; the end of the text when it never does. */
function closingOf(query: string, open: number): number {
  let depth = 0;
  for (let at = open; at < query.length; at++) {
    const char = query[at];
    if (char === '"') at = query.indexOf('"', at + 1) === -1 ? query.length : query.indexOf('"', at + 1);
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return at;
  }
  return query.length;
}
