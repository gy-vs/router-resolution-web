/**
 * 解释结果视图。
 *
 * 公开结果分两级：
 *  - summary：终态、版本、分层计数、候选总数、最终参数，体积与路由表大小无关；
 *  - compact：在 summary 之上内联“淘汰原因码 + 候选 ref”（不含完整路由对象）；
 *  - full：通过 expand() 按需取回单个候选的完整定义（服务端持有，按 ref 投影）。
 *
 * 设计约束：一张很长的路由表不允许把每个无关路由的完整对象发给调用方。
 */

const LAYERS = ['target', 'app', 'mount', 'resource', 'method', 'query', 'compute', 'ranking', 'decode', 'handler'];

/**
 * 摘要视图：体积 O(1) 于路由表规模。
 */
export function toSummary(explanation) {
  const layerCounts = {};
  for (const name of LAYERS) {
    const layer = explanation.layers[name];
    layerCounts[name] = layer ? layer.submitted.length : 0;
  }

  const branches = explanation.branches ?? [];
  const candidatesConsidered = branches.reduce(
    (n, b) => n + (b.mountResults ? b.mountResults.filter((m) => m.matched).length : 0),
    0
  );

  return {
    view: 'summary',
    explanationId: explanation.id,
    correlationId: explanation.correlationId,
    snapshotVersion: explanation.snapshotVersion,
    snapshotFingerprint: explanation.snapshotFingerprint,
    reason: explanation.reason,
    status: explanation.status,
    request: explanation.request,
    hostNormalized: explanation.decodedParamsView?.host ?? null,
    rawTarget: explanation.decodedParamsView?.rawTarget ?? explanation.request.target,
    methodAllow: explanation.methodAllow,
    layerCounts,
    branches: branches.length,
    candidateRefsConsidered: candidatesConsidered,
    rankSize: explanation.rankTable?.length ?? 0,
    winner: explanation.winner,
    finalParams: explanation.finalParams
      ? {
          scopes: explanation.finalParams.scopes,
          byName: explanation.finalParams.byName
        }
      : null,
    failure: explanation.reason && explanation.reason !== 'MATCHED'
      ? {
          reason: explanation.reason,
          layer: explanation.evidence?.layer ?? null,
          stage: explanation.evidence?.stage ?? null,
          code: explanation.evidence?.code ?? null,
          message: explanation.error
        }
      : null,
    asyncEvidence: {
      outOfOrder: explanation.asyncEvidence.outOfOrder,
      foreignIgnored: explanation.asyncEvidence.foreignIgnored,
      staleIgnored: explanation.asyncEvidence.staleIgnored,
      submitted: explanation.asyncEvidence.submittedOrder.length,
      settled: explanation.asyncEvidence.settledOrder.length
    },
    durationMs: explanation.finishedAt - explanation.startedAt
  };
}

/**
 * 紧凑视图：摘要 + 每层淘汰原因码与候选 ref（仍然不含完整路由对象）。
 * @param {object} explanation
 * @param {{maxEliminationsPerLayer?:number}} [opts]
 */
export function toCompact(explanation, opts = {}) {
  const maxPerLayer = opts.maxEliminationsPerLayer ?? 20;
  const summary = toSummary(explanation);
  const compact = {
    ...summary,
    view: 'compact',
    normalizationEvents: explanation.normalizationEvents,
    layers: {},
    eliminated: {},
    rankTable: explanation.rankTable,
    serverCompute: explanation.serverCompute
  };

  for (const name of LAYERS) {
    const layer = explanation.layers[name];
    if (!layer) continue;
    compact.layers[name] = {
      submitted: layer.submitted,
      jobs: layer.jobs.map((j) => ({
        kind: j.kind,
        seq: j.seq,
        ok: j.ok,
        label: j.label
      }))
    };
  }

  // 淘汰证据（应用/挂载在 branches 镜像，资源在 resolver 内存对象之外，由 attach 提供）
  compact.eliminated = explanation._projection?.eliminations ?? compact.eliminated;

  if (explanation.evidence && explanation.reason !== 'MATCHED') {
    compact.failureDetail = projectFailure(explanation.evidence, maxPerLayer);
  }
  return compact;
}

function projectFailure(evidence, maxPerLayer) {
  if (!evidence) return null;
  if (Array.isArray(evidence.failures)) {
    return {
      layer: evidence.layer,
      winner: evidence.winner ?? null,
      failures: evidence.failures.slice(0, maxPerLayer).map((f) => ({
        scope: f.scope,
        name: f.name,
        stage: f.stage,
        message: f.message,
        rule: f.rule,
        raw: f.raw,
        ref: f.ref
      })),
      truncated: evidence.failures.length > maxPerLayer
    };
  }
  if (Array.isArray(evidence.candidates)) {
    return {
      ...evidence,
      candidates: evidence.candidates.slice(0, maxPerLayer),
      candidatesTruncated: evidence.candidates.length > maxPerLayer
    };
  }
  return evidence;
}

/**
 * 按候选 ref 展开完整候选（从服务端快照投影）。
 *
 * @param {object} store SnapshotStore
 * @param {object} explanation
 * @param {{appId:string,mountId:string,routeId:string}} ref
 */
export function expandCandidate(store, explanation, ref) {
  const snapshot = store.get(explanation.snapshotVersion);
  if (!snapshot) {
    return {
      ok: false,
      reason: 'SNAPSHOT_UNKNOWN',
      message: `快照版本 ${explanation.snapshotVersion} 已不存在，无法展开候选；请用 regression sample 恢复`
    };
  }
  const app = snapshot.apps.find((a) => a.id === ref.appId);
  const mount = app?.mounts.find((m) => m.id === ref.mountId);
  const route = mount?.routes.find((r) => r.id === ref.routeId);
  if (!route) return { ok: false, reason: 'CANDIDATE_UNKNOWN', ref };

  return {
    ok: true,
    ref,
    snapshotVersion: snapshot.version,
    app: { id: app.id, hosts: app.def.hosts ?? ['*'] },
    mount: { id: mount.id, path: mount.def.path, paramRules: mount.paramRules },
    route: {
      id: route.id,
      path: route.def.path,
      methods: route.methods,
      priority: route.priority,
      handler: route.handler,
      paramRules: route.paramRules,
      queryRules: route.queryRules
    }
  };
}

/**
 * 展开某层的淘汰明细（由 explanation 中保存的镜像投影）。
 * @param {object} explanation
 * @param {'app'|'mount'|'resource'|'method'} layer
 * @param {{offset?:number,limit?:number}} [page]
 */
export function expandLayer(explanation, layer, page = {}) {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 50;
  const eliminations = explanation._projection?.eliminations?.[layer] ?? [];
  return {
    layer,
    total: eliminations.length,
    offset,
    limit,
    items: eliminations.slice(offset, offset + limit)
  };
}
