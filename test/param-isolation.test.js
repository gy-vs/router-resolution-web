import test from "node:test";
import assert from "node:assert/strict";
import { RouteResolutionService, Classification, lookupParam } from "../src/index.js";
import { keptRouteNode } from "./helpers.js";

/**
 * Same parameter name (`:tenant`) appears at the mount layer and at the
 * route layer, and under two different mount points. The params view must
 * keep every layer's frame separate — a flat global dictionary would
 * silently overwrite one of them.
 */
function layeredSnapshot() {
  return {
    version: "v1",
    apps: {
      a: {
        routes: [
          {
            id: "r-same",
            path: "/users/:tenant",
            methods: ["GET"],
            handler: {
              name: "h",
              guard: {
                require: { "mount:tenant": "^[a-z]+$", "route:tenant": "^\\d+$" },
              },
            },
          },
        ],
      },
    },
    mounts: [
      { id: "m-eu", prefix: "/eu/:tenant", app: "a" },
      { id: "m-us", prefix: "/us/:tenant", app: "a" },
    ],
  };
}

test("mount and route params with the same name stay in separate scopes", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(layeredSnapshot());
  const res = await svc.explain({ method: "GET", target: "/eu/acme/users/42" });
  assert.equal(res.classification, Classification.MATCHED);

  // Both frames exist; neither overwrote the other.
  assert.deepEqual(res.params.scopes, [
    { scope: "mount", refId: "m-eu", params: { tenant: "acme" } },
    { scope: "route", refId: "r-same", params: { tenant: "42" } },
  ]);
  assert.equal(lookupParam(res.params, "mount:tenant"), "acme");
  assert.equal(lookupParam(res.params, "route:tenant"), "42");
  // Bare name resolves route-scope first.
  assert.equal(lookupParam(res.params, "tenant"), "42");
});

test("the same mount param name means different things under different mounts", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(layeredSnapshot());
  const eu = await svc.explain({ method: "GET", target: "/eu/acme/users/1" });
  const us = await svc.explain({ method: "GET", target: "/us/acme/users/1" });
  assert.equal(eu.params.scopes[0].refId, "m-eu");
  assert.equal(us.params.scopes[0].refId, "m-us");
  assert.equal(lookupParam(eu.params, "mount:tenant"), "acme");
  assert.equal(lookupParam(us.params, "mount:tenant"), "acme");
});

test("handler guard reads mount and route scopes independently", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(layeredSnapshot());
  // route:tenant is not numeric -> handler rejects even though mount:tenant is fine
  const rejected = await svc.explain({ method: "GET", target: "/eu/acme/users/abc" });
  assert.equal(rejected.classification, Classification.HANDLER_REJECTED);
  const tree = await svc.getLayerTree(rejected.explanationId);
  const node = keptRouteNode(tree) ?? tree.layers[0].candidates
    .flatMap((m) => m.children)
    .find((c) => c.failedAt === "handler");
  assert.match(node.reason, /route:tenant/);
});

test("candidate detail exposes both scopes' decoded params separately", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(layeredSnapshot());
  const res = await svc.explain({ method: "GET", target: "/eu/acme/users/42" });
  const tree = await svc.getLayerTree(res.explanationId);
  const kept = keptRouteNode(tree);
  const detail = await svc.getCandidateDetail(res.explanationId, kept.candidateId);
  assert.deepEqual(detail.evaluation.decode.mountParams, { tenant: "acme" });
  assert.deepEqual(detail.evaluation.decode.routeParams, { tenant: "42" });
});
