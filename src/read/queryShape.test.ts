import { describe, expect, it } from "vitest";
import { threeDeepConnectionsIn } from "./queryShape.ts";

describe("the shape GitHub charges for", () => {
  it("finds a connection inside a connection inside a connection, by its path", () => {
    const query = `
      query ($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: OPEN, first: 25, after: $after) {
            nodes {
              number
              reviews(first: 100) { nodes { body comments(first: 50) { nodes { path line body } } } }
            }
          }
        }
      }
    `;

    expect(threeDeepConnectionsIn(query)).toEqual(["pullRequests > reviews > comments"]);
  });

  it("counts a connection read with `last`, an aliased one and one behind an inline fragment", () => {
    const query = `
      query {
        repository(owner: "o", name: "r") {
          issues(last: 10) {
            nodes {
              events: timelineItems(last: 100) {
                nodes { ... on CrossReferencedEvent { source { ... on Issue { labels(first: 5) { nodes { name } } } } } }
              }
            }
          }
        }
      }
    `;

    expect(threeDeepConnectionsIn(query)).toEqual(["issues > timelineItems > labels"]);
  });

  it("passes two deep, a field that takes other arguments, and a variable named like a page size", () => {
    const query = `
      query ($owner: String!, $first: Int!) {
        repository(owner: $owner, name: "r") {
          issues(states: OPEN, first: $first) {
            nodes { number labels(first: 50) { nodes { name } } parent { labels(first: 5) { nodes { name } } } subIssues { totalCount } }
          }
        }
      }
    `;

    expect(threeDeepConnectionsIn(query)).toEqual([]);
  });
});
