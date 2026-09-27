import test from "node:test";
import assert from "node:assert/strict";
import { RouteResolutionService, Classification } from "../src/index.js";

/**
 * Long route tables: the public result must lead with a bounded summary and
 * let the caller expand candidates on demand. The server must not serialize
 * full route objects for every irrelevant candidate.
 */
function bigSnapshot(routeCount = 500) {
  const routes = [];
  for (let i = 0; i < routeCount; i += 1) {
    routes.push({
      id: `r-${i}`,
      path: `/r${i}/:id`,
      methods: ["GET"],
      decode: { allowEncodedSlash: i % 2 === 0 },
      handler: { name: `h-${i}`, guard: { rejectIf: { "route:id": ["banned"] } } },
    });
  }
  routes.push({ id: "r-target", path: "/users/:id", methods: ["GET"], handler: { name: "user.show" } });
  return {
    version: "v1",
    apps: { big: { routes } },
    mounts: [{ id: "m-big", prefix: "/big", app: "big" }],
  };
}

test("summary stays bounded no matter how large the route table is", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(bigSnapshot(500));
  const res = await svc.explain({ method: "GET", target: "/big/users/9" });

  assert.equal(res.classification, Classification.MATCHED);
  assert.equal(res.layers.find((l) => l.key === "route").evaluated, 501);
  assert.equal(res.layers.find((l) => l.key === "route").eliminated, 500);
  assert.ok(res.preview.length <= 3, "preview is capped");
  assert.equal(res.preview[0].outcome, "kept", "the winner leads the preview");

  const json = JSON.stringify(res);
  assert.ok(json.length < 2000, `summary is bounded (got ${json.length} bytes)`);
  assert.ok(!json.includes('"h-'), "no handler names of irrelevant routes leak");
  assert.ok(!json.includes("allowEncodedSlash"), "no decode rules leak into the summary");
  assert.ok(!json.includes("/r0/"), "irrelevant route patterns stay server-side");
});

test("layer tree carries candidate refs, not route definitions", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(bigSnapshot(500));
  const res = await svc.explain({ method: "GET", target: "/big/users/9" });
  const tree = await svc.getLayerTree(res.explanationId);

  const mount = tree.layers[0].candidates.find((m) => m.refId === "m-big");
  assert.equal(mount.children.length, 501);
  const json = JSON.stringify(tree);
  assert.ok(!json.includes('"h-'), "no handler names in the tree");
  assert.ok(!json.includes("allowEncodedSlash"), "no decode rules in the tree");
  assert.ok(!json.includes("rejectIf"), "no guard definitions in the tree");
  // ...but every candidate still carries its elimination reason.
  const eliminated = mount.children.filter((c) => c.outcome === "eliminated");
  assert.equal(eliminated.length, 500);
  assert.ok(eliminated.every((c) => c.reasonCode === "STATIC_MISMATCH"));
});

test("candidate detail returns exactly one full route object on demand", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(bigSnapshot(500));
  const res = await svc.explain({ method: "GET", target: "/big/users/9" });
  const tree = await svc.getLayerTree(res.explanationId);
  const mount = tree.layers[0].candidates.find((m) => m.refId === "m-big");
  const some = mount.children.find((c) => c.refId === "r-7");

  const detail = await svc.getCandidateDetail(res.explanationId, some.candidateId);
  assert.equal(detail.definition.handler.name, "h-7");
  assert.deepEqual(detail.definition.decode, { allowEncodedSlash: false });
  assert.deepEqual(detail.definition.handler.guard, { rejectIf: { "route:id": ["banned"] } });
  assert.equal(detail.evaluation.path.reasonCode, "STATIC_MISMATCH");
  assert.equal(detail.mount.id, "m-big");
});

test("top reasons aggregate the dominant elimination causes", async () => {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(bigSnapshot(500));
  const res = await svc.explain({ method: "GET", target: "/big/users/9" });
  const routeLayer = res.layers.find((l) => l.key === "route");
  assert.deepEqual(routeLayer.topReasons[0], { code: "STATIC_MISMATCH", count: 500 });
});
