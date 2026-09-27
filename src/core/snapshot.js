import { RouterError } from "./errors.js";
import { deepFreeze } from "./util.js";
import { compilePattern } from "./pattern.js";

/**
 * Route snapshots: the versioned, immutable input to the matching engine.
 *
 * Authored shape:
 * {
 *   version: "v1",
 *   apps: {
 *     shop: {
 *       routes: [{
 *         id: "r-user",
 *         path: "/users/:id(\\d+)",
 *         methods: ["GET"],                 // optional; absent = any method
 *         host: "api.example.com",          // optional; string | string[]
 *         strictTrailingSlash: false,       // optional
 *         decode: { allowEncodedSlash: false }, // optional
 *         handler: { name: "user.show", guard: { require: {...}, rejectIf: {...} } }
 *       }]
 *     }
 *   },
 *   mounts: [{
 *     id: "m-shop",
 *     prefix: "/shop/:tenant",
 *     app: "shop",
 *     host: "*.example.com",                // optional
 *     collapseSlashes: false,               // optional
 *     decode: { allowEncodedSlash: false }  // optional, applies to mount params
 *   }]
 * }
 */

function invalid(message) {
  return new RouterError("INVALID_SNAPSHOT", message);
}

function compileChecked(source, what) {
  try {
    return compilePattern(source);
  } catch (err) {
    throw invalid(`${what}: ${err.message}`);
  }
}

function validateGuard(guard, what) {
  if (guard == null) return;
  for (const [section, table] of Object.entries(guard)) {
    if (section === "require") {
      for (const [key, pattern] of Object.entries(table ?? {})) {
        try {
          new RegExp(`^(?:${pattern})$`);
        } catch {
          throw invalid(`${what}: bad guard require regex for "${key}"`);
        }
      }
    } else if (section === "rejectIf") {
      for (const [key, values] of Object.entries(table ?? {})) {
        if (!Array.isArray(values)) {
          throw invalid(`${what}: guard rejectIf "${key}" must be an array`);
        }
      }
    } else {
      throw invalid(`${what}: unknown guard section "${section}"`);
    }
  }
}

/** Validate and normalize an authored snapshot. Returns a normalized clone. */
export function validateSnapshot(input) {
  if (input == null || typeof input !== "object") {
    throw invalid("snapshot must be an object");
  }
  const snap = structuredClone(input);
  if (typeof snap.version !== "string" || snap.version === "") {
    throw invalid("snapshot.version must be a non-empty string");
  }
  snap.apps = snap.apps ?? {};
  snap.mounts = snap.mounts ?? [];
  if (typeof snap.apps !== "object" || Array.isArray(snap.apps)) {
    throw invalid("snapshot.apps must be an object keyed by app id");
  }
  if (!Array.isArray(snap.mounts)) {
    throw invalid("snapshot.mounts must be an array");
  }

  for (const [appId, app] of Object.entries(snap.apps)) {
    app.routes = app.routes ?? [];
    if (!Array.isArray(app.routes)) {
      throw invalid(`app "${appId}": routes must be an array`);
    }
    const seen = new Set();
    for (const route of app.routes) {
      const what = `app "${appId}" route "${route?.id ?? "?"}"`;
      if (typeof route?.id !== "string" || route.id === "") {
        throw invalid(`app "${appId}": every route needs a non-empty id`);
      }
      if (seen.has(route.id)) {
        throw invalid(`${what}: duplicate route id`);
      }
      seen.add(route.id);
      compileChecked(route.path, `${what} path`);
      if (route.methods != null) {
        if (
          !Array.isArray(route.methods) ||
          route.methods.some((m) => typeof m !== "string" || m === "")
        ) {
          throw invalid(`${what}: methods must be an array of non-empty strings`);
        }
        route.methods = route.methods.map((m) => m.toUpperCase());
      }
      if (route.decode != null && typeof route.decode !== "object") {
        throw invalid(`${what}: decode must be an object`);
      }
      if (route.handler != null) {
        if (typeof route.handler.name !== "string" || route.handler.name === "") {
          throw invalid(`${what}: handler.name must be a non-empty string`);
        }
        validateGuard(route.handler.guard, what);
      }
    }
  }

  const seenMounts = new Set();
  for (const mount of snap.mounts) {
    const what = `mount "${mount?.id ?? "?"}"`;
    if (typeof mount?.id !== "string" || mount.id === "") {
      throw invalid("every mount needs a non-empty id");
    }
    if (seenMounts.has(mount.id)) {
      throw invalid(`${what}: duplicate mount id`);
    }
    seenMounts.add(mount.id);
    if (snap.apps[mount.app] == null) {
      throw invalid(`${what}: references unknown app "${mount.app}"`);
    }
    compileChecked(mount.prefix, `${what} prefix`);
    if (mount.decode != null && typeof mount.decode !== "object") {
      throw invalid(`${what}: decode must be an object`);
    }
  }
  return snap;
}

function compileSnapshot(snap) {
  return {
    mounts: snap.mounts.map((def) => ({ def, prefix: compilePattern(def.prefix) })),
    apps: new Map(
      Object.entries(snap.apps).map(([appId, app]) => [
        appId,
        app.routes.map((def) => ({ def, pattern: compilePattern(def.path) })),
      ]),
    ),
  };
}

/**
 * Immutable version store. Loading the same version twice is rejected so a
 * version id always denotes exactly one route table — explanations pinned to
 * a version can never observe it drift.
 */
export class SnapshotRegistry {
  #byVersion = new Map();

  load(snapshot) {
    const snap = validateSnapshot(snapshot);
    if (this.#byVersion.has(snap.version)) {
      throw new RouterError(
        "VERSION_EXISTS",
        `snapshot version "${snap.version}" is already loaded and versions are immutable`,
      );
    }
    const compiled = compileSnapshot(snap);
    this.#byVersion.set(snap.version, {
      version: snap.version,
      snapshot: deepFreeze(snap),
      compiled,
    });
    return snap.version;
  }

  get(version) {
    const entry = this.#byVersion.get(version);
    if (!entry) {
      throw new RouterError("UNKNOWN_VERSION", `unknown snapshot version "${version}"`);
    }
    return entry;
  }

  has(version) {
    return this.#byVersion.has(version);
  }

  latest() {
    const keys = [...this.#byVersion.keys()];
    if (keys.length === 0) {
      throw new RouterError("NO_SNAPSHOT", "no route snapshot has been loaded");
    }
    return keys[keys.length - 1];
  }

  list() {
    return [...this.#byVersion.values()].map((entry) => ({
      version: entry.version,
      mounts: entry.snapshot.mounts.length,
      apps: Object.keys(entry.snapshot.apps).length,
      routes: Object.values(entry.snapshot.apps).reduce(
        (n, app) => n + app.routes.length,
        0,
      ),
    }));
  }

  toJSON() {
    return [...this.#byVersion.values()].map((entry) => ({
      version: entry.version,
      snapshot: structuredClone(entry.snapshot),
    }));
  }
}
