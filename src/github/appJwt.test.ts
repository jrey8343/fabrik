import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt } from "./appJwt.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const NOW = Date.parse("2026-11-05T00:00:00Z");

function decoded(part: string | undefined): unknown {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
}

describe("the Fabrik App's JWT", () => {
  it("is an RS256 JWT the App's key signed, issued by its client ID", () => {
    const [header, payload, signature] = appJwt("Iv23client", PEM, NOW).split(".");

    expect(decoded(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
    expect(decoded(payload)).toMatchObject({ iss: "Iv23client" });
  });

  it("was issued a minute back, for clock drift, and lasts under GitHub's ten-minute limit", () => {
    const [, payload] = appJwt("Iv23client", PEM, NOW).split(".");
    const { iat, exp } = decoded(payload) as { iat: number; exp: number };

    expect(iat).toBe(NOW / 1000 - 60);
    expect(exp - iat).toBeLessThanOrEqual(600);
    expect(exp).toBeGreaterThan(NOW / 1000);
  });
});
