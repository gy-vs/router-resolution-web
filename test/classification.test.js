import test from "node:test";
import assert from "node:assert/strict";
import { RouteResolutionService, Classification } from "../src/index.js";
import { baseSnapshot, routeNode } from "./helpers.js";

const REQ = { method: "GET", host: "api.example.com" };

function serviceWith(snapshot = baseSnapshot("v1")) {
  const svc = new RouteResolutionService();
  svc.loadSnapshot(snapshot);
  return svc;
}

test("MATCHED: winner, handler and scoped params are reported", async () => {
  const svc = serviceWith();
  const res = await svc.explain({ ...REQ, target: "/shop/acme/users/42" });
  assert.equal(res.classification, Classification.MATCHED);
  assert.equal(res.winner.routeId, "r-user");
  assert.equal(res.winner.mountId, "m-shop");
  assert.equal(res.winner.handler, "user.show");
  assert.deepEqual(res.params.scopes, [
    { scope: "mount", refId: "m-shop", params: { tenant: "acme" } },
    { scope: "route", refId: "r-user", params: { id: "42" } },
  ]);
});

test("NO_MATCH: nothing survives path matching", async () => {
  const svc = serviceWith();
  const res = await svc.explain({ ...REQ, target: "/shop/acme/nope" });
  assert.equal(res.classification, Classification.NO_MATCH);
  assert.equal(res.winner, null);
  assert.equal(res.params, null);
  assert.equal(res.allow, null);
});

test("METHOD_NOT_ALLOWED: path matched, method did not; allow lists every matched method", async () => {
  const svc = serviceWith();
  const res = await svc.explain({ ...REQ, method: "DELETE", target: "/shop/acme/users/42" });
  assert.equal(res.classification, Classification.METHOD_NOT_ALLOWED);
  assert.deepEqual([...res.allow].sort(), ["GET", "POST"]);
  const tree = await svc.getLayerTree(res.explanationId);
  assert.equal(routeNode(tree, "m-shop", "r-user").failedAt, "method");
  assert.equal(routeNode(tree, "m-shop", "r-user-post").failedAt, "method");
});

test("PARAM_DECODE_FAILED: malformed percent sequence", async () => {
  const svc = serviceWith();
  const res = await svc.explain({ ...REQ, target: "/shop/acme/files/%E0%A4" });
  assert.equal(res.classification, Classification.PARAM_DECODE_FAILED);
  const tree = await svc.getLayerTree(res.explanationId);
  const node = routeNode(tree, "m-shop", "r-file");
  assert.equal(node.failedAt, "decode");
  assert.equal(node.reasonCode, "MALFORMED_ENCODING");
});

test("HANDLER_REJECTED: handler guard rejects after successful decode", async () => {
  const svc = serviceWith();
  const res = await svc.explain({
    method: "GET",
    host: "admin.example.com",
    target: "/admin/evil/dash",
  });
  assert.equal(res.classification, Classification.HANDLER_REJECTED);
  const tree = await svc.getLayerTree(res.explanationId);
  const node = routeNode(tree, "m-admin", "r-dash");
  assert.equal(node.failedAt, "handler");
  assert.equal(node.reasonCode, "HANDLER_REJECTED");
  assert.match(node.reason, /mount:tenant/);
});

test("handler guard passes for an allowed tenant", async () => {
  const svc = serviceWith();
  const res = await svc.explain({
    method: "GET",
    host: "admin.example.com",
    target: "/admin/acme/dash",
  });
  assert.equal(res.classification, Classification.MATCHED);
  assert.equal(res.winner.handler, "admin.dash");
});

test("classification follows the deepest failed stage (decode beats method)", async () => {
  const svc = serviceWith({
    version: "v1",
    apps: {
      a: {
        routes: [
          { id: "r-get", path: "/x/:p", methods: ["GET"], handler: { name: "g" } },
          { id: "r-post", path: "/x/:p", methods: ["POST"], handler: { name: "p" } },
        ],
      },
    },
    mounts: [{ id: "m", prefix: "/", app: "a" }],
  });
  // GET fails decode on r-get; r-post only fails the method stage.
  const res = await svc.explain({ method: "GET", target: "/x/%E0%A4" });
  assert.equal(res.classification, Classification.PARAM_DECODE_FAILED);
  // PUT fails method on both routes -> 405 with the union of allowed methods.
  const res405 = await svc.explain({ method: "PUT", target: "/x/abc" });
  assert.equal(res405.classification, Classification.METHOD_NOT_ALLOWED);
  assert.deepEqual([...res405.allow].sort(), ["GET", "POST"]);
});

test("invalid requests and unknown references raise typed errors", async () => {
  const svc = serviceWith();
  await assert.rejects(svc.explain({ target: "/x" }), /method/);
  await assert.rejects(
    svc.explain({ method: "GET", target: "no-leading-slash" }),
    (err) => err.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    svc.explain({ method: "GET", target: "/x" }, { version: "nope" }),
    (err) => err.code === "UNKNOWN_VERSION",
  );
  await assert.rejects(svc.getLayerTree("exp-999"), (err) => err.code === "UNKNOWN_EXPLANATION");
  const res = await svc.explain({ ...REQ, target: "/shop/acme/users/42" });
  await assert.rejects(
    svc.getCandidateDetail(res.explanationId, "R-999"),
    (err) => err.code === "UNKNOWN_CANDIDATE",
  );
});
