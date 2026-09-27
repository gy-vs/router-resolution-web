import { createDirectTransport } from "../src/index.js";

/**
 * Base snapshot used across suites:
 *   mounts: m-shop (host wildcard + mount param), m-admin (guard demo),
 *           m-flat (collapseSlashes), m-strict (no collapse)
 *   routes: method pair, encoded-slash pair, strict-trailing-slash, root
 */
export function baseSnapshot(version = "v1") {
  return {
    version,
    apps: {
      shop: {
        routes: [
          { id: "r-user", path: "/users/:id(\\d+)", methods: ["GET"], handler: { name: "user.show" } },
          { id: "r-user-post", path: "/users/:id(\\d+)", methods: ["POST"], handler: { name: "user.update" } },
          { id: "r-file", path: "/files/:name", methods: ["GET"], handler: { name: "file.show" } },
          {
            id: "r-slug",
            path: "/slugs/:name",
            methods: ["GET"],
            decode: { allowEncodedSlash: true },
            handler: { name: "slug.show" },
          },
          {
            id: "r-exact",
            path: "/exact",
            methods: ["GET"],
            strictTrailingSlash: true,
            handler: { name: "exact" },
          },
          { id: "r-root", path: "/", methods: ["GET"], handler: { name: "home" } },
        ],
      },
      admin: {
        routes: [
          {
            id: "r-dash",
            path: "/dash",
            methods: ["GET"],
            host: "admin.example.com",
            handler: {
              name: "admin.dash",
              guard: { require: { "mount:tenant": "^(acme|globex)$" } },
            },
          },
        ],
      },
    },
    mounts: [
      { id: "m-shop", prefix: "/shop/:tenant", app: "shop", host: "*.example.com" },
      { id: "m-admin", prefix: "/admin/:tenant", app: "admin" },
      { id: "m-flat", prefix: "/flat", app: "shop", collapseSlashes: true },
      { id: "m-strict", prefix: "/strict", app: "shop" },
    ],
  };
}

/**
 * A transport wrapper whose responses only resolve when the test flushes
 * them — lets race tests resolve responses in any order they like.
 */
export function controllable(service) {
  const direct = createDirectTransport(service);
  const calls = [];
  const transport = (method, params) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    calls.push({
      method,
      params,
      async flush() {
        try {
          resolve(await direct(method, params));
        } catch (err) {
          reject(err);
        }
      },
    });
    return promise;
  };
  return { transport, calls };
}

/** Find the kept route candidate node inside a layer tree view. */
export function keptRouteNode(tree) {
  for (const mount of tree.layers[0].candidates) {
    const hit = mount.children.find((c) => c.outcome === "kept");
    if (hit) return hit;
  }
  return null;
}

/** Find a route candidate node by mount id + route id. */
export function routeNode(tree, mountRefId, routeRefId) {
  const mount = tree.layers[0].candidates.find((m) => m.refId === mountRefId);
  return mount?.children.find((c) => c.refId === routeRefId) ?? null;
}
