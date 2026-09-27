import test from "node:test";
import assert from "node:assert/strict";
import { RouteResolutionService, Classification, lookupParam } from "../src/index.js";
import { baseSnapshot, routeNode } from "./helpers.js";

const HOST = "api.example.com";

function serviceWith(snapshot = baseSnapshot("v1")) {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(snapshot);
  return svc;
}

test("encoded slash: rejected by default, kept with allowEncodedSlash", async () => {
  const svc = serviceWith();

  // Default route: %2F must not become a real slash inside the param.
  const denied = await svc.explain({ method: "GET", host: HOST, target: "/shop/acme/files/a%2Fb" });
  assert.equal(denied.classification, Classification.PARAM_DECODE_FAILED);
  const deniedTree = await svc.getLayerTree(denied.explanationId);
  const fileNode = routeNode(deniedTree, "m-shop", "r-file");
  assert.equal(fileNode.failedAt, "decode");
  assert.equal(fileNode.reasonCode, "ENCODED_SLASH");
  const fileDetail = await svc.getCandidateDetail(
    denied.explanationId,
    fileNode.candidateId,
  );
  assert.deepEqual(fileDetail.evaluation.decode.failures, [
    { scope: "route", param: "name", raw: "a%2Fb", error: "ENCODED_SLASH" },
  ]);

  // Opt-in route: the same raw target decodes to a param containing "/".
  const allowed = await svc.explain({ method: "GET", host: HOST, target: "/shop/acme/slugs/a%2Fb" });
  assert.equal(allowed.classification, Classification.MATCHED);
  assert.equal(lookupParam(allowed.params, "route:name"), "a/b");
});

test("encoded slash does not split segments during matching", async () => {
  const svc = serviceWith();
  // /files/a%2Fb is ONE segment for matching; a two-segment pattern must not
  // see the encoded slash as a separator.
  const res = await svc.explain({ method: "GET", host: HOST, target: "/shop/acme/files/a%2Fb" });
  const tree = await svc.getLayerTree(res.explanationId);
  const node = routeNode(tree, "m-shop", "r-file");
  assert.equal(node.stages.path, "ok", "path stage matched on the raw segment");
});

test("duplicate separators: collapse policy changes the candidate set per mount", async () => {
  const svc = serviceWith();

  // Mount with collapseSlashes: the doubled separator is normalized away.
  const collapsed = await svc.explain({ method: "GET", host: HOST, target: "/flat//users/42" });
  assert.equal(collapsed.classification, Classification.MATCHED);
  assert.equal(collapsed.winner.routeId, "r-user");
  assert.ok(
    collapsed.normalizations.some(
      (n) => n.kind === "collapse-slashes" && n.mountId === "m-flat",
    ),
  );

  // Same path shape through the mount without collapse: no route survives.
  const strict = await svc.explain({ method: "GET", host: HOST, target: "/strict//users/42" });
  assert.equal(strict.classification, Classification.NO_MATCH);

  // And the empty segment is reported precisely when lengths still line up.
  const precise = await svc.explain({ method: "GET", host: HOST, target: "/strict//users" });
  const tree = await svc.getLayerTree(precise.explanationId);
  const node = routeNode(tree, "m-strict", "r-user");
  assert.equal(node.reasonCode, "EMPTY_SEGMENT");
});

test("trailing slash: strict routes reject, tolerant routes normalize", async () => {
  const svc = serviceWith();

  const strictMiss = await svc.explain({ method: "GET", host: HOST, target: "/flat/exact/" });
  assert.equal(strictMiss.classification, Classification.NO_MATCH);
  const missTree = await svc.getLayerTree(strictMiss.explanationId);
  assert.equal(routeNode(missTree, "m-flat", "r-exact").reasonCode, "TRAILING_SLASH_STRICT");

  const strictHit = await svc.explain({ method: "GET", host: HOST, target: "/flat/exact" });
  assert.equal(strictHit.classification, Classification.MATCHED);
  assert.equal(strictHit.winner.routeId, "r-exact");

  const tolerant = await svc.explain({ method: "GET", host: HOST, target: "/flat/users/42/" });
  assert.equal(tolerant.classification, Classification.MATCHED);
  assert.equal(tolerant.winner.routeId, "r-user");
  assert.ok(tolerant.normalizations.some((n) => n.kind === "trailing-slash"));
});

test("host case is normalized; host conditions still filter candidates", async () => {
  const svc = serviceWith();

  // Uppercase host matches the wildcard mount condition.
  const upper = await svc.explain({
    method: "GET",
    host: "API.Example.COM",
    target: "/shop/acme/users/42",
  });
  assert.equal(upper.classification, Classification.MATCHED);
  assert.ok(upper.normalizations.some((n) => n.kind === "host-case"));
  assert.equal(upper.request.host, "api.example.com");

  // Bare apex does not satisfy "*.example.com": the mount is eliminated.
  const apex = await svc.explain({ method: "GET", host: "example.com", target: "/shop/acme/users/42" });
  const apexTree = await svc.getLayerTree(apex.explanationId);
  const shopMount = apexTree.layers[0].candidates.find((m) => m.refId === "m-shop");
  assert.equal(shopMount.outcome, "eliminated");
  assert.equal(shopMount.reasonCode, "HOST_MISMATCH");

  // Route-level host condition: wrong host eliminates the candidate.
  const wrongHost = await svc.explain({
    method: "GET",
    host: "www.example.com",
    target: "/admin/acme/dash",
  });
  assert.equal(wrongHost.classification, Classification.NO_MATCH);
  const wrongTree = await svc.getLayerTree(wrongHost.explanationId);
  const dash = routeNode(wrongTree, "m-admin", "r-dash");
  assert.equal(dash.failedAt, "host");
  assert.equal(dash.reasonCode, "HOST_MISMATCH");

  // Same route, uppercase host: matches.
  const okHost = await svc.explain({
    method: "GET",
    host: "ADMIN.example.COM",
    target: "/admin/acme/dash",
  });
  assert.equal(okHost.classification, Classification.MATCHED);
});

test("query string is preserved in the view but excluded from matching", async () => {
  const svc = serviceWith();
  const res = await svc.explain({
    method: "GET",
    host: HOST,
    target: "/shop/acme/users/42?tab=a%2Fb&x=%E0%A4",
  });
  assert.equal(res.classification, Classification.MATCHED);
  assert.equal(res.request.rawPath, "/shop/acme/users/42");
  assert.equal(res.request.query, "tab=a%2Fb&x=%E0%A4");
  assert.equal(res.request.target, "/shop/acme/users/42?tab=a%2Fb&x=%E0%A4");
});

test("method case is normalized and recorded", async () => {
  const svc = serviceWith();
  const res = await svc.explain({ method: "get", host: HOST, target: "/shop/acme/users/42" });
  assert.equal(res.classification, Classification.MATCHED);
  assert.ok(res.normalizations.some((n) => n.kind === "method-case"));
});
