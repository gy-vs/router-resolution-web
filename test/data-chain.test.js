import test from "node:test";
import assert from "node:assert/strict";
import {
  RouteResolutionService,
  ExplanationWorkbench,
  createDirectTransport,
  Classification,
} from "../src/index.js";
import { baseSnapshot, keptRouteNode } from "./helpers.js";

const REQ = { method: "GET", host: "api.example.com", target: "/shop/acme/users/42" };

test("summary -> tree -> detail -> sample -> replay all reference the same chain", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));

  const summary = await svc.explain(REQ);
  const tree = await svc.getLayerTree(summary.explanationId);
  assert.equal(tree.explanationId, summary.explanationId);
  assert.equal(tree.version, summary.version);

  const kept = keptRouteNode(tree);
  const detail = await svc.getCandidateDetail(summary.explanationId, kept.candidateId);
  assert.equal(detail.explanationId, summary.explanationId);
  assert.equal(detail.version, summary.version);

  const sample = await svc.createSample(summary.explanationId, { name: "chain" });
  assert.equal(sample.sourceExplanationId, summary.explanationId);
  assert.equal(sample.pinnedVersion, summary.version);
  assert.deepEqual(sample.request, summary.request);

  const replay = await svc.replaySample(sample.id);
  assert.equal(replay.same, true);
  assert.equal(replay.pinnedVersion, summary.version);
  // The replay itself produced a new, inspectable explanation.
  const replayTree = await svc.getLayerTree(replay.explanationId);
  assert.equal(replayTree.classification, summary.classification);
});

test("repeated calls produce independent, equally retrievable explanations", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  const a = await svc.explain(REQ);
  const b = await svc.explain(REQ);
  assert.notEqual(a.explanationId, b.explanationId);
  assert.equal(a.classification, b.classification);
  const [ta, tb] = await Promise.all([
    svc.getLayerTree(a.explanationId),
    svc.getLayerTree(b.explanationId),
  ]);
  assert.equal(ta.classification, Classification.MATCHED);
  assert.equal(tb.classification, Classification.MATCHED);
});

test("export/restore preserves the whole data chain", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  const summary = await svc.explain(REQ);
  const sample = await svc.createSample(summary.explanationId, { name: "restore-me" });

  const restored = RouteResolutionService.restore(svc.exportState());

  // Snapshots, explanations and samples all survive the round trip.
  assert.deepEqual(restored.listSnapshots(), svc.listSnapshots());
  const tree = await restored.getLayerTree(summary.explanationId);
  assert.equal(tree.classification, Classification.MATCHED);
  const kept = keptRouteNode(tree);
  const detail = await restored.getCandidateDetail(summary.explanationId, kept.candidateId);
  assert.equal(detail.definition.handler.name, "user.show");

  // Samples replay identically on the restored service.
  const replay = await restored.replaySample(sample.id);
  assert.equal(replay.same, true);
  assert.equal(replay.pinnedVersion, "v1");

  // Id counters continue without colliding with restored ids.
  const fresh = await restored.explain(REQ);
  assert.ok(![summary.explanationId, replay.explanationId].includes(fresh.explanationId));
  const freshSample = await restored.createSample(fresh.explanationId);
  assert.notEqual(freshSample.id, sample.id);
});

test("workbench walks the same chain through the transport", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  const wb = new ExplanationWorkbench({ transport: createDirectTransport(svc) });

  const { summary } = await wb.explain(REQ);
  assert.equal(wb.view.current.classification, Classification.MATCHED);

  await wb.expandLayers();
  const mounts = wb.view.layers.layers[0].candidates;
  assert.equal(mounts.length, 4, "all four mounts appear as candidates");
  const kept = keptRouteNode(wb.view.layers);
  assert.equal(kept.refId, "r-user");

  await wb.expandCandidate(kept.candidateId);
  const detail = wb.view.details[kept.candidateId];
  assert.equal(detail.definition.handler.name, "user.show");
  assert.deepEqual(detail.evaluation.decode.mountParams, { tenant: "acme" });
  assert.deepEqual(detail.evaluation.decode.routeParams, { id: "42" });

  const sample = await wb.pinAsSample("workbench-chain");
  assert.equal(sample.sourceExplanationId, summary.explanationId);
  const replay = await wb.replaySample(sample.id);
  assert.equal(replay.same, true);
  assert.equal(wb.view.replays.length, 1);
  assert.equal(wb.view.samples.length, 1);
});
