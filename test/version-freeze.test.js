import test from "node:test";
import assert from "node:assert/strict";
import { RouteResolutionService, Classification } from "../src/index.js";
import { baseSnapshot, keptRouteNode } from "./helpers.js";

const REQ = { method: "GET", host: "api.example.com", target: "/shop/acme/users/42" };

function v2Snapshot() {
  const snap = baseSnapshot("v2");
  // v2 removes the /users routes entirely and changes r-slug's handler.
  snap.apps.shop.routes = snap.apps.shop.routes.filter(
    (r) => r.id !== "r-user" && r.id !== "r-user-post",
  );
  snap.apps.shop.routes.find((r) => r.id === "r-slug").handler = { name: "slug.v2" };
  return snap;
}

test("an in-flight explanation stays bound to its snapshot version", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  const before = await svc.explain(REQ);
  assert.equal(before.version, "v1");
  assert.equal(before.classification, Classification.MATCHED);

  svc.loadSnapshot(v2Snapshot());

  // The old explanation still resolves against v1 — tree, summary and detail.
  const tree = await svc.getLayerTree(before.explanationId);
  assert.equal(tree.version, "v1");
  assert.equal(tree.classification, Classification.MATCHED);
  const summary = await svc.getSummary(before.explanationId);
  assert.equal(summary.classification, Classification.MATCHED);

  // Candidate detail comes from the pinned v1 snapshot, not the live v2 one:
  // r-slug's handler was renamed in v2, but the v1 explanation still shows v1.
  const slugNode = tree.layers[0].candidates
    .find((m) => m.refId === "m-shop")
    .children.find((c) => c.refId === "r-slug");
  const detail = await svc.getCandidateDetail(before.explanationId, slugNode.candidateId);
  assert.equal(detail.version, "v1");
  assert.equal(detail.definition.handler.name, "slug.show");

  // A fresh explain of the same request uses the latest version (v2).
  const after = await svc.explain(REQ);
  assert.equal(after.version, "v2");
  assert.equal(after.classification, Classification.NO_MATCH);

  // ...unless the caller pins the version explicitly.
  const pinned = await svc.explain(REQ, { version: "v1" });
  assert.equal(pinned.version, "v1");
  assert.equal(pinned.classification, Classification.MATCHED);
});

test("snapshot versions are immutable", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  assert.throws(() => svc.loadSnapshot(baseSnapshot("v1")), (err) => err.code === "VERSION_EXISTS");
});

test("regression samples replay green on the pinned version and diff on a newer one", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  const before = await svc.explain(REQ);
  const sample = await svc.createSample(before.explanationId, { name: "user-42" });
  assert.equal(sample.sourceExplanationId, before.explanationId);
  assert.equal(sample.pinnedVersion, "v1");

  svc.loadSnapshot(v2Snapshot());

  // Replay against the pinned version: exact reproduction.
  const green = await svc.replaySample(sample.id);
  assert.equal(green.replayedVersion, "v1");
  assert.equal(green.versionChanged, false);
  assert.equal(green.same, true);
  assert.deepEqual(green.diffs, []);

  // Replay against v2: the version difference is spelled out.
  const drift = await svc.replaySample(sample.id, { version: "v2" });
  assert.equal(drift.replayedVersion, "v2");
  assert.equal(drift.versionChanged, true);
  assert.equal(drift.same, false);
  const kinds = drift.diffs.map((d) => d.kind);
  assert.ok(kinds.includes("classification"));
  const classificationDiff = drift.diffs.find((d) => d.kind === "classification");
  assert.equal(classificationDiff.expected, Classification.MATCHED);
  assert.equal(classificationDiff.actual, Classification.NO_MATCH);
  // Candidate-level evidence: the winner route is gone in v2.
  const routeDiff = drift.diffs.find(
    (d) => d.kind === "candidate:routes" && d.ref === "m-shop/r-user",
  );
  assert.equal(routeDiff.expected, "kept");
  assert.equal(routeDiff.actual, "(absent)");
});

test("replay produces a new, inspectable explanation each time", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  const first = await svc.explain(REQ);
  const sample = await svc.createSample(first.explanationId);
  const replay = await svc.replaySample(sample.id);
  assert.notEqual(replay.explanationId, first.explanationId);
  const tree = await svc.getLayerTree(replay.explanationId);
  assert.equal(tree.classification, Classification.MATCHED);
  assert.ok(keptRouteNode(tree));
});
