import { RouterError } from "./errors.js";
import { deepFreeze } from "./util.js";

/**
 * Explanation records and their public views.
 *
 * Three views of the same trace, in increasing detail (and payload size):
 *   summaryView          -> counts, top reasons, top-K candidate previews
 *   layerTreeView        -> every candidate as a lightweight ref (no route
 *                           definitions), nested mount -> routes
 *   candidateDetailView  -> the full route/mount definition for ONE candidate
 *
 * The server never serializes full route objects for irrelevant candidates;
 * long route tables cost a bounded summary plus on-demand single-candidate
 * detail calls.
 */

const STAGE_DEPTH = Object.freeze({
  host: 0,
  path: 1,
  method: 2,
  decode: 3,
  handler: 4,
});
const STAGE_ORDER = ["host", "path", "method", "decode", "handler"];

export class ExplanationStore {
  #byId = new Map();
  #seq = 0;

  create({ version, trace }) {
    this.#seq += 1;
    const explanation = deepFreeze({ id: `exp-${this.#seq}`, version, trace });
    this.#byId.set(explanation.id, explanation);
    return explanation;
  }

  get(id) {
    const explanation = this.#byId.get(id);
    if (!explanation) {
      throw new RouterError("UNKNOWN_EXPLANATION", `unknown explanation "${id}"`);
    }
    return explanation;
  }

  toJSON() {
    return { seq: this.#seq, items: [...this.#byId.values()] };
  }

  static fromJSON(data) {
    const store = new ExplanationStore();
    store.#seq = data.seq;
    for (const item of data.items) {
      store.#byId.set(item.id, deepFreeze(item));
    }
    return store;
  }
}

function depthOf(candidate) {
  return candidate.outcome === "kept" ? 5 : STAGE_DEPTH[candidate.failedAt] ?? -1;
}

function layerSummary(candidates) {
  const reasons = new Map();
  let kept = 0;
  for (const c of candidates) {
    if (c.outcome === "kept") {
      kept += 1;
      continue;
    }
    reasons.set(c.reasonCode, (reasons.get(c.reasonCode) ?? 0) + 1);
  }
  const topReasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => ({ code, count }));
  return {
    evaluated: candidates.length,
    kept,
    eliminated: candidates.length - kept,
    topReasons,
  };
}

/** Bounded summary: counts, top reasons, top-K candidate previews. */
export function summaryView(explanation, { previewLimit = 3 } = {}) {
  const t = explanation.trace;
  const preview = [...t.routeCandidates]
    .sort((a, b) => depthOf(b) - depthOf(a) || a.order - b.order)
    .slice(0, Math.max(0, previewLimit))
    .map((c) => ({
      candidateId: c.id,
      routeId: c.refId,
      appId: c.appId,
      mountId: c.mountRefId,
      outcome: c.outcome,
      failedAt: c.failedAt,
      reasonCode: c.reasonCode,
    }));
  return {
    explanationId: explanation.id,
    version: explanation.version,
    classification: t.classification,
    request: t.request,
    normalizations: t.normalizations,
    layers: [
      { key: "mount", ...layerSummary(t.mountCandidates) },
      { key: "route", ...layerSummary(t.routeCandidates) },
    ],
    preview,
    winner: t.winner,
    params: t.params,
    allow: t.allow,
  };
}

function stageOutline(stages) {
  const out = {};
  for (const key of STAGE_ORDER) {
    const stage = stages[key];
    out[key] = stage == null ? "skipped" : stage.ok ? "ok" : "failed";
  }
  return out;
}

/** Full candidate tree, still as lightweight refs (no route definitions). */
export function layerTreeView(explanation) {
  const t = explanation.trace;
  const mounts = t.mountCandidates.map((mc) => ({
    candidateId: mc.id,
    refId: mc.refId,
    label: mc.label,
    order: mc.order,
    outcome: mc.outcome,
    reasonCode: mc.reasonCode,
    reason: mc.reason,
    children: t.routeCandidates
      .filter((rc) => rc.mountCandidateId === mc.id)
      .map((rc) => ({
        candidateId: rc.id,
        refId: rc.refId,
        appId: rc.appId,
        label: rc.label,
        order: rc.order,
        outcome: rc.outcome,
        failedAt: rc.failedAt,
        reasonCode: rc.reasonCode,
        reason: rc.reason,
        stages: stageOutline(rc.stages),
      })),
  }));
  return {
    explanationId: explanation.id,
    version: explanation.version,
    classification: t.classification,
    request: t.request,
    normalizations: t.normalizations,
    layers: [{ key: "mount", candidates: mounts }],
    winner: t.winner,
    params: t.params,
    allow: t.allow,
  };
}

/**
 * Full detail for exactly one candidate: the complete route/mount definition
 * resolved from the explanation's *pinned* snapshot version, plus the
 * per-stage evaluation record.
 */
export function candidateDetailView(explanation, candidateId, pinnedEntry) {
  const t = explanation.trace;

  const mc = t.mountCandidates.find((c) => c.id === candidateId);
  if (mc) {
    const def =
      pinnedEntry.compiled.mounts.find((m) => m.def.id === mc.refId)?.def ?? null;
    return {
      explanationId: explanation.id,
      version: explanation.version,
      kind: "mount",
      candidateId,
      refId: mc.refId,
      outcome: mc.outcome,
      reasonCode: mc.reasonCode,
      reason: mc.reason,
      definition: def,
      evaluation: { rawParams: mc.rawParams, remaining: mc.remaining },
    };
  }

  const rc = t.routeCandidates.find((c) => c.id === candidateId);
  if (!rc) {
    throw new RouterError(
      "UNKNOWN_CANDIDATE",
      `explanation "${explanation.id}" has no candidate "${candidateId}"`,
    );
  }
  const mountDef =
    pinnedEntry.compiled.mounts.find((m) => m.def.id === rc.mountRefId)?.def ?? null;
  const routeDef =
    pinnedEntry.compiled.apps.get(rc.appId)?.find((r) => r.def.id === rc.refId)?.def ??
    null;
  return {
    explanationId: explanation.id,
    version: explanation.version,
    kind: "route",
    candidateId,
    refId: rc.refId,
    appId: rc.appId,
    mountId: rc.mountRefId,
    outcome: rc.outcome,
    failedAt: rc.failedAt,
    reasonCode: rc.reasonCode,
    reason: rc.reason,
    definition: routeDef,
    mount: mountDef,
    evaluation: rc.stages,
  };
}
