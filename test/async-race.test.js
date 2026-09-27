import test from "node:test";
import assert from "node:assert/strict";
import { RouteResolutionService, ExplanationWorkbench, Classification } from "../src/index.js";
import { baseSnapshot, controllable } from "./helpers.js";

const REQ_A = { method: "GET", host: "api.example.com", target: "/shop/acme/users/42" };
const REQ_B = { method: "GET", host: "api.example.com", target: "/shop/acme/nope" };

function setup() {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(baseSnapshot("v1"));
  const { transport, calls } = controllable(svc);
  const wb = new ExplanationWorkbench({ transport });
  return { svc, wb, calls };
}

test("a stale explain response is discarded, the latest one wins", async () => {
  const { wb, calls } = setup();
  const pA = wb.explain(REQ_A);
  const pB = wb.explain(REQ_B);

  // Server finishes the OLDER request last (out-of-order return).
  await calls[1].flush();
  const rB = await pB;
  await calls[0].flush();
  const rA = await pA;

  assert.equal(rB.stale, false);
  assert.equal(rA.stale, true);
  assert.equal(wb.view.current.classification, Classification.NO_MATCH);
  assert.equal(wb.view.discarded.length, 1);
  assert.equal(wb.view.discarded[0].kind, "explain");
  // The discarded response is kept as evidence, including what it computed.
  assert.equal(wb.view.discarded[0].classification, Classification.MATCHED);
});

test("a stale layer-tree response does not overwrite the current view", async () => {
  const { wb, calls } = setup();
  const pA = wb.explain(REQ_A);
  await calls[0].flush();
  await pA;
  assert.equal(wb.view.current.classification, Classification.MATCHED);

  const treePromise = wb.expandLayers(); // calls[1], left pending
  const pB = wb.explain(REQ_B); // calls[2]
  await calls[2].flush();
  await pB; // view moved on to explanation B

  await calls[1].flush(); // A's layer tree arrives late
  const treeResult = await treePromise;

  assert.equal(treeResult.stale, true);
  assert.equal(wb.view.layers, null);
  assert.ok(wb.view.discarded.some((d) => d.kind === "layers"));
});

test("a stale candidate-detail response is discarded", async () => {
  const { wb, calls } = setup();
  const pA = wb.explain(REQ_A);
  await calls[0].flush();
  await pA;

  const detailPromise = wb.expandCandidate("R1"); // calls[1], pending
  const pB = wb.explain(REQ_B); // calls[2]
  await calls[2].flush();
  await pB;

  await calls[1].flush();
  const detailResult = await detailPromise;

  assert.equal(detailResult.stale, true);
  assert.deepEqual(wb.view.details, {});
  assert.ok(wb.view.discarded.some((d) => d.kind === "candidate" && d.candidateId === "R1"));
});

test("replays are independent of view races", async () => {
  const { wb, calls } = setup();
  const pA = wb.explain(REQ_A);
  await calls[0].flush();
  await pA;

  const samplePromise = wb.pinAsSample("race"); // calls[1]
  await calls[1].flush();
  const sample = await samplePromise;

  const replayPromise = wb.replaySample(sample.id); // calls[2], pending
  const pB = wb.explain(REQ_B); // calls[3], a newer view request in flight
  await calls[3].flush();
  await pB;
  await calls[2].flush();
  const replay = await replayPromise;

  assert.equal(replay.same, true);
  assert.equal(wb.view.replays.length, 1);
  assert.equal(wb.view.current.classification, Classification.NO_MATCH);
});

test("concurrent server-side explains stay independent and retrievable", async () => {
  const { svc } = setup();
  const [s1, s2, s3] = await Promise.all([
    svc.explain(REQ_A),
    svc.explain(REQ_B),
    svc.explain(REQ_A),
  ]);
  const ids = [s1.explanationId, s2.explanationId, s3.explanationId];
  assert.equal(new Set(ids).size, 3, "each call gets its own explanation id");
  const [t1, t2, t3] = await Promise.all(ids.map((id) => svc.getLayerTree(id)));
  assert.equal(t1.classification, Classification.MATCHED);
  assert.equal(t2.classification, Classification.NO_MATCH);
  assert.equal(t3.classification, Classification.MATCHED);
});
