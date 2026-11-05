// The Fabrik App's own JWT, signed with its private key, for the few calls an
// App makes as itself rather than as an installation (such as asking whether
// it's installed on a repo). Installation tokens still come from
// actions/create-github-app-token; this mints none.
import { createSign } from "node:crypto";

/** A JWT for the App with this client ID, signed RS256 with its key, valid for about nine minutes from `now` (ms). */
export function appJwt(clientId: string, privateKey: string, now: number): string {
  // Issued a minute back so a runner's clock ahead of GitHub's doesn't make it not yet valid.
  const iat = Math.floor(now / 1000) - 60;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat, exp: iat + 600, iss: clientId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}
