import { RouterError } from "./errors.js";
import { splitRawPath, collapseEmptySegments, matchPrefix, matchSegments } from "./pattern.js";
import { normalizeHost, hostMatches, formatHostCondition } from "./host.js";
import { decodeParams, evaluateGuard, buildParamsView } from "./params.js";

/**
 * Final classification of an explanation. The four failure kinds are
 * mutually exclusive and ordered by how far the best candidate progressed:
 *   MATCHED               -> a candidate passed every stage
 *   HANDLER_REJECTED      -> deepest failure: handler guard
 *   PARAM_DECODE_FAILED   -> deepest failure: parameter decoding
 *   METHOD_NOT_ALLOWED    -> deepest failure: method constraint
 *   NO_MATCH              -> no candidate survived host/path matching
 */
export const Classification = Object.freeze({
  MATCHED: "MATCHED",
  NO_MATCH: "NO_MATCH",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  PARAM_DECODE_FAILED: "PARAM_DECODE_FAILED",
  HANDLER_REJECTED: "HANDLER_REJECTED",
});

/** How far a route candidate progressed; deeper failures classify the result. */
const STAGE_DEPTH = Object.freeze({
  host: 0,
  path: 1,
  method: 2,
  decode: 3,
  handler: 4,
});

function normalizeRequest(request) {
  if (request == null || typeof request !== "object") {
    throw new RouterError("INVALID_REQUEST", "request must be an object");
  }
  const rawMethod = request.method;
  const method = typeof rawMethod === "string" ? rawMethod.toUpperCase() : "";
  if (!method) {
    throw new RouterError("INVALID_REQUEST", "request.method must be a non-empty string");
  }
  const target = request.target;
  if (typeof target !== "string" || !target.startsWith("/")) {
    throw new RouterError(
      "INVALID_REQUEST",
      "request.target must be an origin-form path starting with '/'",
    );
  }
  const qi = target.indexOf("?");
  const rawPath = qi < 0 ? target : target.slice(0, qi);
  const query = qi < 0 ? null : target.slice(qi + 1);
  const hostInfo = normalizeHost(request.host);
  const notes = [];
  if (rawMethod !== method) {
    notes.push({ kind: "method-case", from: rawMethod, to: method });
  }
  if (hostInfo.changed) {
    notes.push({ kind: "host-case", from: request.host, to: hostInfo.host });
  }
  return {
    view: { method, host: hostInfo.host, target, rawPath, query },
    method,
    host: hostInfo.host,
    rawPath,
    notes,
  };
}

function evaluateRoute(route, mount, mountCandidate, req, normalizations, order) {
  const rc = {
    id: `R${order + 1}`,
    refId: route.def.id,
    appId: mount.def.app,
    mountCandidateId: mountCandidate.id,
    mountRefId: mount.def.id,
    order,
    label: route.def.path,
    handlerName: route.def.handler?.name ?? null,
    outcome: "eliminated",
    failedAt: null,
    reasonCode: null,
    reason: null,
    stages: {},
    scopes: null,
  };

  // Stage: host condition
  if (!hostMatches(route.def.host, req.host)) {
    rc.stages.host = { ok: false, condition: route.def.host ?? null, actual: req.host };
    rc.failedAt = "host";
    rc.reasonCode = "HOST_MISMATCH";
    rc.reason = `host ${req.host ?? "(none)"} does not satisfy ${formatHostCondition(route.def.host)}`;
    return rc;
  }
  rc.stages.host = { ok: true };

  // Stage: path pattern
  const strict = route.def.strictTrailingSlash === true;
  const m = matchSegments(route.pattern, mountCandidate.remaining, {
    strictTrailingSlash: strict,
  });
  if (!m.matched) {
    rc.stages.path = { ok: false, reasonCode: m.reasonCode, detail: m.reason };
    rc.failedAt = "path";
    rc.reasonCode = m.reasonCode;
    rc.reason = m.reason;
    return rc;
  }
  rc.stages.path = { ok: true, rawParams: m.rawParams };
  if (m.trailingNormalized) {
    rc.stages.path.trailingSlashNormalized = true;
    normalizations.push({
      kind: "trailing-slash",
      mountId: mount.def.id,
      routeId: route.def.id,
    });
  }

  // Stage: method constraint
  const methods = route.def.methods ?? null;
  if (methods && !methods.includes(req.method)) {
    rc.stages.method = { ok: false, allowed: [...methods], actual: req.method };
    rc.failedAt = "method";
    rc.reasonCode = "METHOD_MISMATCH";
    rc.reason = `method ${req.method} not allowed; allowed: ${methods.join(", ")}`;
    return rc;
  }
  rc.stages.method = { ok: true, allowed: methods ? [...methods] : null };

  // Stage: parameter decoding (mount params under mount rules, route params
  // under route rules — scopes stay separate)
  const mountDec = decodeParams(mountCandidate.rawParams ?? {}, mount.def.decode);
  const routeDec = decodeParams(m.rawParams ?? {}, route.def.decode);
  const failures = [
    ...mountDec.failures.map((f) => ({ scope: "mount", ...f })),
    ...routeDec.failures.map((f) => ({ scope: "route", ...f })),
  ];
  rc.stages.decode = {
    ok: failures.length === 0,
    mountParams: mountDec.params,
    routeParams: routeDec.params,
    failures,
  };
  if (failures.length > 0) {
    const f = failures[0];
    rc.failedAt = "decode";
    rc.reasonCode = f.error;
    rc.reason = `cannot decode param ${f.scope}:${f.param} (raw "${f.raw}"): ${f.error}`;
    return rc;
  }

  // Stage: handler guard (internal rejection)
  const scopes = {
    mount: { refId: mount.def.id, params: mountDec.params },
    route: { refId: route.def.id, params: routeDec.params },
  };
  const guard = evaluateGuard(route.def.handler?.guard, scopes);
  rc.stages.handler = guard.ok ? { ok: true } : { ok: false, reason: guard.reason };
  if (!guard.ok) {
    rc.failedAt = "handler";
    rc.reasonCode = "HANDLER_REJECTED";
    rc.reason = guard.reason;
    return rc;
  }

  rc.outcome = "kept";
  rc.scopes = scopes;
  return rc;
}

/**
 * Run the layered match for one request against one compiled snapshot and
 * return the full explanation trace (plain data, JSON-serializable).
 */
export function explainRequest(compiled, request) {
  const req = normalizeRequest(request);
  const normalizations = [...req.notes];
  const rawSegments = splitRawPath(req.rawPath);

  const mountCandidates = [];
  const routeCandidates = [];

  compiled.mounts.forEach((mount, mountIndex) => {
    const mc = {
      id: `M${mountCandidates.length + 1}`,
      refId: mount.def.id,
      label: mount.def.prefix,
      order: mountIndex,
      outcome: "eliminated",
      reasonCode: null,
      reason: null,
      rawParams: null,
      remaining: null,
    };
    mountCandidates.push(mc);

    if (!hostMatches(mount.def.host, req.host)) {
      mc.reasonCode = "HOST_MISMATCH";
      mc.reason = `host ${req.host ?? "(none)"} does not satisfy ${formatHostCondition(mount.def.host)}`;
      return;
    }

    // Per-mount separator policy: duplicate slashes may or may not collapse,
    // which changes this mount's candidate set — record the normalization.
    let segs = rawSegments;
    if (mount.def.collapseSlashes === true) {
      const collapsed = collapseEmptySegments(rawSegments);
      if (collapsed.length !== rawSegments.length) {
        normalizations.push({
          kind: "collapse-slashes",
          mountId: mount.def.id,
          from: `/${rawSegments.join("/")}`,
          to: `/${collapsed.join("/")}`,
        });
        segs = collapsed;
      }
    }

    const pm = matchPrefix(mount.prefix, segs);
    if (!pm.matched) {
      mc.reasonCode = pm.reasonCode;
      mc.reason = pm.reason;
      return;
    }
    mc.outcome = "kept";
    mc.rawParams = pm.rawParams;
    mc.remaining = segs.slice(pm.consumed);

    const routes = compiled.apps.get(mount.def.app) ?? [];
    for (const route of routes) {
      routeCandidates.push(
        evaluateRoute(route, mount, mc, req, normalizations, routeCandidates.length),
      );
    }
  });

  const winner = routeCandidates.find((c) => c.outcome === "kept") ?? null;
  let classification;
  let allow = null;
  if (winner) {
    classification = Classification.MATCHED;
  } else {
    const deepest = routeCandidates.reduce(
      (acc, c) => Math.max(acc, STAGE_DEPTH[c.failedAt] ?? -1),
      -1,
    );
    if (deepest >= STAGE_DEPTH.handler) {
      classification = Classification.HANDLER_REJECTED;
    } else if (deepest === STAGE_DEPTH.decode) {
      classification = Classification.PARAM_DECODE_FAILED;
    } else if (deepest === STAGE_DEPTH.method) {
      classification = Classification.METHOD_NOT_ALLOWED;
    } else {
      classification = Classification.NO_MATCH;
    }
    if (classification === Classification.METHOD_NOT_ALLOWED) {
      allow = [
        ...new Set(
          routeCandidates
            .filter((c) => c.failedAt === "method")
            .flatMap((c) => c.stages.method.allowed),
        ),
      ];
    }
  }

  return {
    request: req.view,
    normalizations,
    mountCandidates,
    routeCandidates,
    classification,
    allow,
    winner: winner
      ? {
          routeCandidateId: winner.id,
          routeId: winner.refId,
          appId: winner.appId,
          mountId: winner.mountRefId,
          handler: winner.handlerName,
        }
      : null,
    params: winner ? buildParamsView(winner.scopes) : null,
  };
}
