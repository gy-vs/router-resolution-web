/**
 * Hierarchical parameter scopes, decoding rules and handler guards.
 *
 * Parameters are never merged into one global dictionary. Every layer that
 * captures parameters (a mount point, a route) gets its own scope frame, so
 * `:tenant` under mount `m-eu` and `:tenant` under route `r-same` coexist
 * without overwriting each other. Qualified lookups use `mount:name` /
 * `route:name`; a bare name resolves route-scope first, then mount-scope.
 */

/**
 * Decode captured raw parameters according to per-layer rules.
 *   rules.allowEncodedSlash === true  -> a decoded "/" inside a value is kept
 *   otherwise                         -> decoded "/" fails with ENCODED_SLASH
 * Malformed percent sequences fail with MALFORMED_ENCODING.
 * Returns `{ ok, params, failures }` where failures carry `{param, raw, error}`.
 */
export function decodeParams(rawParams, rules = {}) {
  const params = {};
  const failures = [];
  for (const [name, raw] of Object.entries(rawParams ?? {})) {
    let value;
    try {
      value = decodeURIComponent(raw);
    } catch {
      failures.push({ param: name, raw, error: "MALFORMED_ENCODING" });
      continue;
    }
    if (rules.allowEncodedSlash !== true && value.includes("/")) {
      failures.push({ param: name, raw, error: "ENCODED_SLASH" });
      continue;
    }
    params[name] = value;
  }
  return { ok: failures.length === 0, params, failures };
}

function splitQualified(qualifiedName) {
  const i = qualifiedName.indexOf(":");
  if (i < 0) return { scope: null, name: qualifiedName };
  return { scope: qualifiedName.slice(0, i), name: qualifiedName.slice(i + 1) };
}

/** Resolve `mount:x` / `route:x` / bare `x` against internal scope objects. */
export function resolveScoped(scopes, qualifiedName) {
  const { scope, name } = splitQualified(qualifiedName);
  if (scope) return scopes[scope]?.params?.[name];
  return scopes.route?.params?.[name] ?? scopes.mount?.params?.[name];
}

/**
 * Deterministic handler guard — models "the handler internally rejected the
 * request" without executing user code:
 *   guard.require: { "route:id": "^\\d+$" }  -> param must exist and match
 *   guard.rejectIf: { "mount:tenant": ["banned"] } -> param must not be listed
 * Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function evaluateGuard(guard, scopes) {
  if (guard == null) return { ok: true };
  for (const [qualifiedName, pattern] of Object.entries(guard.require ?? {})) {
    const value = resolveScoped(scopes, qualifiedName);
    if (value == null) {
      return { ok: false, reason: `guard require failed: ${qualifiedName} is missing` };
    }
    if (!new RegExp(`^(?:${pattern})$`).test(value)) {
      return {
        ok: false,
        reason: `guard require failed: ${qualifiedName}="${value}" does not match ${pattern}`,
      };
    }
  }
  for (const [qualifiedName, banned] of Object.entries(guard.rejectIf ?? {})) {
    const value = resolveScoped(scopes, qualifiedName);
    if (value != null && banned.includes(value)) {
      return { ok: false, reason: `guard rejectIf: ${qualifiedName}="${value}" is rejected` };
    }
  }
  return { ok: true };
}

/** Build the public decoded-parameter view: an ordered list of scope frames. */
export function buildParamsView(scopes) {
  const frames = [];
  if (Object.keys(scopes.mount.params).length > 0) {
    frames.push({ scope: "mount", refId: scopes.mount.refId, params: { ...scopes.mount.params } });
  }
  if (Object.keys(scopes.route.params).length > 0) {
    frames.push({ scope: "route", refId: scopes.route.refId, params: { ...scopes.route.params } });
  }
  return { scopes: frames };
}

/**
 * Lookup in the public params view (`{scopes:[{scope, refId, params}]}`).
 * Accepts `mount:tenant`, `route:id`, or a bare name (route scope first).
 */
export function lookupParam(paramsView, qualifiedName) {
  if (paramsView == null) return undefined;
  const { scope, name } = splitQualified(qualifiedName);
  const frames = paramsView.scopes ?? [];
  const findIn = (scopeName) =>
    frames.find((f) => f.scope === scopeName)?.params?.[name];
  if (scope) return findIn(scope);
  return findIn("route") ?? findIn("mount");
}
