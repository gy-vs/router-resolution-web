import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

test("public entry exposes the full acceptance surface", () => {
  for (const name of [
    "RouteResolutionService",
    "ExplanationWorkbench",
    "createDirectTransport",
    "lookupParam",
    "RouterError",
    "SnapshotRegistry",
    "validateSnapshot",
  ]) {
    assert.equal(typeof api[name], "function", `missing export: ${name}`);
  }
  assert.equal(typeof api.Classification, "object", "missing export: Classification");
  assert.deepEqual(Object.keys(api.Classification).sort(), [
    "HANDLER_REJECTED",
    "MATCHED",
    "METHOD_NOT_ALLOWED",
    "NO_MATCH",
    "PARAM_DECODE_FAILED",
  ]);
});

test("snapshot validation rejects broken input with typed errors", () => {
  const svc = new api.RouteResolutionService();
  assert.throws(
    () => svc.loadSnapshot({ version: "v1", mounts: [{ id: "m", prefix: "/x", app: "ghost" }] }),
    (err) => err.code === "INVALID_SNAPSHOT" && /unknown app/.test(err.message),
  );
  assert.throws(
    () =>
      svc.loadSnapshot({
        version: "v1",
        apps: { a: { routes: [{ id: "r", path: "no-slash" }] } },
        mounts: [],
      }),
    (err) => err.code === "INVALID_SNAPSHOT",
  );
  assert.throws(
    () =>
      svc.loadSnapshot({
        version: "v1",
        apps: {
          a: {
            routes: [
              {
                id: "r",
                path: "/x",
                handler: { name: "h", guard: { require: { "route:x": "([" } } },
              },
            ],
          },
        },
        mounts: [],
      }),
    (err) => err.code === "INVALID_SNAPSHOT" && /guard/.test(err.message),
  );
});
