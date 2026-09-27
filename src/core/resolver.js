/**
 * 分层匹配内核。
 *
 * 解析一条请求的完整流水线（每层都是一次总线查询，见 bus.js）：
 *
 *   target 归一化（编码斜杠/重复分隔符/尾斜杠/主机边界）
 *     └─ W1 app：主机条件扫描
 *        └─ W2 mount：挂载点前缀匹配（挂载参数进入分支作用域）
 *           └─ W3 resource：资源模式匹配 + 调用方候选排序
 *              └─ W4 method：方法约束（405 证据来自此处）
 *                 └─ W5 query 查询层查询 / 服务端计算（可乱序）
 *                    └─ W6 ranking：跨分支统一排序
 *                       └─ W7 decode：分层参数解码（app/mount/resource/query 隔离）
 *                          └─ W8 handler：处理器执行（内部拒绝证据）
 *
 * 任一阶段无候选即终止；但已经产出的层证据、候选 ref 与淘汰原因全部保留，
 * 因此“为什么在看起来匹配时返回错误”可以逐层定位。
 */
import { Reason, DecodeFailure, HandlerRejection, RoutingFailure } from './errors.js';
import { parseTarget, DEFAULT_POLICY } from './target.js';
import { matchHost, matchMountPrefix, matchResourcePattern } from './patterns.js';
import { decodeLayer } from './decode.js';
import { genId } from './identifiers.js';

const LAYER_ORDER = [
  'target',
  'app',
  'mount',
  'resource',
  'method',
  'query',
  'compute',
  'ranking',
  'decode',
  'handler'
];

function createLayer(name) {
  return {
    layer: name,
    submitted: [],
    jobs: [],
    startedAt: null,
    endedAt: null
  };
}

function segmentRef(segment) {
  return {
    kind: 'segment',
    start: segment.start,
    end: segment.end,
    raw: segment.raw,
    splitFrom: segment.splitFrom ?? null
  };
}

function refsFromIndices(paramIndices, segments) {
  const refs = {};
  for (const [name, index] of Object.entries(paramIndices)) {
    if (typeof index === 'object') {
      refs[name] = segments.slice(index.splatFrom, index.splatTo).map(segmentRef);
    } else {
      refs[name] = segmentRef(segments[index]);
    }
  }
  return refs;
}

/**
 * 查询规则按 app -> mount -> resource 顺序合并；同名规则以更近的层为准，
 * 不同名规则同时生效（trace 定义在 app、limit 定义在 mount、tag 定义在 resource）。
 */
function mergeQueryRules(appRules, mountRules, routeRules) {
  const byName = new Map();
  for (const rule of appRules) byName.set(rule.name, rule);
  for (const rule of mountRules) byName.set(rule.name, rule);
  for (const rule of routeRules) byName.set(rule.name, rule);
  return [...byName.values()];
}

function hostRefs(hostParams, normalizedHost, hostPattern, paramLabels) {
  const labels = normalizedHost.split('.');
  const refs = {};
  for (const name of Object.keys(hostParams)) {
    const labelIndex = paramLabels[name];
    refs[name] = { kind: 'host-label', index: labelIndex, raw: labels[labelIndex] };
  }
  return refs;
}

function queryRefs(entries) {
  const refs = {};
  for (const e of entries) {
    const ref = { kind: 'query-entry', index: e.index, start: e.start, key: e.key };
    if (refs[e.key]) {
      refs[e.key] = Array.isArray(refs[e.key]) ? [...refs[e.key], ref] : [refs[e.key], ref];
    } else {
      refs[e.key] = ref;
    }
  }
  return refs;
}

function candidateRef(route, mountId, appId) {
  return {
    candidateId: route.id,
    appId,
    mountId,
    routeId: route.id,
    path: route.pattern.source,
    priority: route.priority,
    specificity: route.pattern.specificity
  };
}

/**
 * 执行一次完整解析。
 *
 * @param {object} snapshot SnapshotStore 中的编译快照
 * @param {object} request
 * @param {object} services
 * @param {import('./bus.js').CorrelationBus} services.bus
 * @param {Map<string,Function>} services.handlers
 * @param {object} [options]
 */
export async function resolve(snapshot, request, services, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  const correlationId = options.correlationId ?? genId('corr');
  const resolutionId = genId('res');
  const bus = services.bus;

  const layers = {};
  for (const name of LAYER_ORDER) layers[name] = createLayer(name);

  const explanation = {
    id: resolutionId,
    correlationId,
    snapshotVersion: snapshot.version,
    snapshotFingerprint: snapshot.fingerprint,
    request: {
      method: (request.method ?? 'GET').toUpperCase(),
      host: request.host ?? null,
      target: String(request.target ?? '')
    },
    policy,
    startedAt: Date.now(),
    layers,
    branches: [],
    rankTable: [],
    serverCompute: [],
    finalParams: null,
    winner: null,
    methodAllow: [],
    normalizationEvents: [],
    decodedParamsView: null,
    asyncEvidence: {
      submittedOrder: [],
      settledOrder: [],
      outOfOrder: false,
      foreignIgnored: 0,
      staleIgnored: 0
    },
    // 分层淘汰镜像：只存原因码 + 候选 ref，永不内联完整路由对象
    _projection: {
      eliminations: { app: [], mount: [], resource: [], method: [] }
    },
    reason: null,
    status: null,
    evidence: null,
    error: null,
    finishedAt: null
  };

  let jobCounter = 0;
  const submit = (layerName, kind, compute, label = {}) => {
    const id = `${correlationId}:${kind}:${jobCounter++}`;
    const job = { id, kind, compute, label };
    layers[layerName].submitted.push(id);
    explanation.asyncEvidence.submittedOrder.push(id);
    const { receive, mailbox } = bus.post(job, correlationId);
    return {
      id,
      kind,
      label,
      async receive() {
        const env = await receive();
        explanation.asyncEvidence.settledOrder.push(id);
        explanation.asyncEvidence.foreignIgnored = mailbox.stats.foreign;
        explanation.asyncEvidence.staleIgnored = mailbox.stats.stale;
        layers[layerName].jobs.push({
          jobId: id,
          kind,
          label,
          seq: env.seq,
          ok: env.ok
        });
        return { env };
      }
    };
  };

  const finish = (reason, extra = {}) => {
    explanation.reason = reason;
    explanation.status = extra.status ?? null;
    explanation.evidence = extra.evidence ?? null;
    explanation.error = extra.error ?? null;
    explanation.finishedAt = Date.now();
    explanation.methodAllow = extra.allow ?? explanation.methodAllow;
    // 乱序判定：按后端完成序号排序后的作业，与提交顺序不同即发生过乱序
    // （target 层为同步解析，jobId=null，不参与总线时序比较）
    const settled = Object.values(layers)
      .flatMap((l) => l.jobs)
      .filter((j) => j.jobId !== null && j.jobId !== undefined);
    const bySeq = [...settled].sort((a, b) => a.seq - b.seq).map((j) => j.jobId);
    const submittedPrefix = explanation.asyncEvidence.submittedOrder.filter((id) =>
      bySeq.includes(id)
    );
    explanation.asyncEvidence.outOfOrder = JSON.stringify(bySeq) !== JSON.stringify(submittedPrefix);
    explanation.asyncEvidence.settleSeqOrder = bySeq;
    const box = bus.mailboxes.get(correlationId);
    if (box) {
      explanation.asyncEvidence.foreignIgnored = box.stats.foreign;
      explanation.asyncEvidence.staleIgnored = box.stats.stale;
    }
    bus.markDone(correlationId);
    return explanation;
  };

  // ── target ──────────────────────────────────────────────────────────────
  const parsed = parseTarget(request, policy);
  layers.target.jobs.push({
    jobId: null,
    kind: 'target-parse',
    ok: !parsed.invalid,
    events: parsed.events ?? []
  });
  explanation.normalizationEvents = parsed.events ?? [];
  if (parsed.invalid) {
    return finish(Reason.TARGET_INVALID, {
      status: 400,
      evidence: {
        layer: 'target',
        code: parsed.invalid.code,
        message: parsed.invalid.message,
        segment: parsed.invalid.segment
          ? {
              raw: parsed.invalid.segment.raw,
              start: parsed.invalid.segment.start,
              end: parsed.invalid.segment.end
            }
          : null
      },
      error: parsed.invalid.message
    });
  }

  const trailingPolicy = policy.trailingSlash;
  const method = parsed.method;

  // ── W1 app：主机条件 ─────────────────────────────────────────────────────
  const appReceipts = snapshot.apps.map((app) =>
    submit('app', 'app-host-scan', () => {
      const outcomes = app.hosts.map((h) => {
        if (h.matchesAny) {
          return {
            hostRaw: '*',
            hostIndex: null,
            matched: true,
            params: {},
            refs: {}
          };
        }
        const r = matchHost(h.pattern, parsed.host.normalized);
        if (!r.matched) return { hostRaw: h.raw, hostIndex: null, matched: false, reason: r.reason };
        return {
          hostRaw: h.raw,
          hostIndex: h.priority,
          matched: true,
          params: r.params,
          refs: hostRefs(r.params, parsed.host.normalized, h.pattern, r.paramLabels)
        };
      });
      const hit = outcomes
        .filter((o) => o.matched)
        .sort((a, b) => {
          // 主机条件特异性：取编译后的 specificity（字面量=2，参数=1，通配=0）
          const scoreOf = (o) =>
            o.hostRaw === '*' ? -1 : app.hosts.find((h) => h.raw === o.hostRaw)?.pattern?.specificity ?? 0;
          const d = scoreOf(b) - scoreOf(a);
          if (d !== 0) return d;
          return (a.hostIndex ?? 0) - (b.hostIndex ?? 0);
        })[0];
      return { appId: app.id, matched: Boolean(hit), outcome: hit ?? outcomes[0], all: outcomes };
    }, { appId: app.id })
  );
  const survivingApps = [];
  for (const receipt of appReceipts) {
    const { env } = await receipt.receive();
    const value = env.value;
    if (!env.ok) throw new RoutingFailure(Reason.NO_MATCH, { evidence: env.error });
    if (value.matched) {
      survivingApps.push({ app: snapshot.apps.find((a) => a.id === value.appId), value });
    } else {
      explanation._projection.eliminations.app.push({
        appId: value.appId,
        reason: value.outcome?.reason ?? 'NO_HOST_MATCH',
        hostRequired: snapshot.apps.find((a) => a.id === value.appId).def.hosts
      });
    }
  }

  if (survivingApps.length === 0) {
    return finish(Reason.NO_MATCH, {
      status: 404,
      evidence: {
        layer: 'app',
        message: `没有应用接受主机 "${parsed.host.normalized ?? '(无主机)'}"`,
        host: parsed.host
      }
    });
  }

  // ── W2 mount：挂载点前缀（每个存活应用一个作业，作业内按 specificity/priority/order 排序） ─
  const mountReceipts = survivingApps.map(({ app, value: hostValue }) =>
    submit('mount', 'mount-prefix-scan', () => {
      const results = app.mounts.map((mount) => {
        const r = matchMountPrefix(mount.pattern, parsed.segments, trailingPolicy);
        if (!r.matched) {
          return {
            mountId: mount.id,
            appId: app.id,
            matched: false,
            reason: r.reason,
            at: r.at ?? null,
            path: mount.pattern.source
          };
        }
        return {
          mountId: mount.id,
          appId: app.id,
          matched: true,
          rawParams: r.params,
          refs: refsFromIndices(r.paramIndices, parsed.segments),
          remainder: r.remainder,
          specificity: mount.pattern.specificity,
          priority: mount.priority
        };
      });
      results.sort((a, b) => {
        if (!a.matched) return 1;
        if (!b.matched) return -1;
        if (b.specificity !== a.specificity) return b.specificity - a.specificity;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return 0;
      });
      return { appId: app.id, host: hostValue.outcome, results };
    }, { appId: app.id })
  );

  const branches = [];
  for (const receipt of mountReceipts) {
    const { env } = await receipt.receive();
    const value = env.value;
    const app = survivingApps.find((s) => s.app.id === value.appId).app;
    explanation.branches.push({ appId: app.id, hostOutcome: value.host, mountResults: value.results });
    for (const mr of value.results) {
      if (!mr.matched) {
        explanation._projection.eliminations.mount.push({
          appId: app.id,
          mountId: mr.mountId,
          path: mr.path,
          reason: mr.reason,
          at: mr.at
        });
        continue;
      }
      branches.push({
        app,
        hostParams: value.host.params ?? {},
        hostRefs: value.host.refs ?? {},
        mount: app.mounts.find((m) => m.id === mr.mountId),
        mountRaw: mr.rawParams,
        mountRefs: mr.refs,
        remainder: mr.remainder,
        mountRank: { specificity: mr.specificity, priority: mr.priority }
      });
    }
  }

  if (branches.length === 0) {
    return finish(Reason.NO_MATCH, {
      status: 404,
      evidence: {
        layer: 'mount',
        message: `路径 /${parsed.segments.map((s) => s.raw).join('/')} 未命中任何挂载点`,
        path: parsed.rawPath
      }
    });
  }

  // ── W3 resource：资源模式匹配（每个分支一个作业，候选按 specificity/priority/order 排序） ─
  const resourceReceipts = branches.map((branch, branchIndex) =>
    submit('resource', 'resource-route-query', () => {
      const results = branch.mount.routes.map((route) => {
        const r = matchResourcePattern(route.pattern, branch.remainder, trailingPolicy);
        if (!r.matched) {
          return {
            routeId: route.id,
            matched: false,
            reason: r.reason,
            at: r.at ?? null,
            ref: candidateRef(route, branch.mount.id, branch.app.id)
          };
        }
        const refMap = refsFromIndices(r.paramIndices, branch.remainder);
        return {
          routeId: route.id,
          matched: true,
          rawParams: r.params,
          refs: refMap,
          ref: candidateRef(route, branch.mount.id, branch.app.id),
          specificity: route.pattern.specificity
        };
      });
      results.sort((a, b) => {
        if (!a.matched) return 1;
        if (!b.matched) return -1;
        if (b.specificity !== a.specificity) return b.specificity - a.specificity;
        const ra = branch.mount.routes.find((r) => r.id === a.routeId);
        const rb = branch.mount.routes.find((r) => r.id === b.routeId);
        if (ra.priority !== rb.priority) return ra.priority - rb.priority;
        return ra.routeOrder - rb.routeOrder;
      });
      return { branchIndex, results };
    }, { mountId: branch.mount.id, appId: branch.app.id })
  );

  for (const receipt of resourceReceipts) {
    const { env } = await receipt.receive();
    const { branchIndex, results } = env.value;
    branches[branchIndex].resourceResults = results;
    for (const r of results) {
      if (!r.matched) {
        explanation._projection.eliminations.resource.push({
          ref: r.ref,
          reason: r.reason,
          at: r.at
        });
      }
    }
  }

  const structurallyMatched = branches.filter((b) => b.resourceResults.some((r) => r.matched));
  if (structurallyMatched.length === 0) {
    return finish(Reason.NO_MATCH, {
      status: 404,
      evidence: {
        layer: 'resource',
        message: `挂载点下无资源路由匹配剩余路径`,
        remainder: branches[0].remainder.map((s) => s.raw)
      }
    });
  }

  // ── W4 method：方法约束（每个结构匹配的候选一个作业） ───────────────────
  const methodReceipts = [];
  structurallyMatched.forEach((branch) => {
    branch.methodResults = [];
    for (const mr of branch.resourceResults.filter((r) => r.matched)) {
      const route = branch.mount.routes.find((r) => r.id === mr.routeId);
      const receipt = submit('method', 'method-check', () => ({
        routeId: route.id,
        allowed: route.methodSet.has(method),
        methods: route.methods,
        requested: method
      }), { routeId: route.id });
      methodReceipts.push({ receipt, branch, route, resourceMatch: mr });
    }
  });

  for (const item of methodReceipts) {
    const { env } = await item.receipt.receive();
    item.branch.methodResults.push({
      routeId: item.route.id,
      allowed: env.value.allowed,
      methods: env.value.methods
    });
    if (!env.value.allowed) {
      explanation._projection.eliminations.method.push({
        ref: candidateRef(item.route, item.branch.mount.id, item.branch.app.id),
        reason: 'METHOD_NOT_ALLOWED',
        requested: env.value.requested,
        methods: env.value.methods
      });
    }
  }

  const allowSet = new Set();
  structurallyMatched.forEach((branch) => {
    branch.resourceResults
      .filter((r) => r.matched)
      .forEach((r) => {
        const route = branch.mount.routes.find((x) => x.id === r.routeId);
        route.methods.forEach((m) => allowSet.add(m));
      });
  });
  explanation.methodAllow = [...allowSet];

  const methodSurvivors = [];
  structurallyMatched.forEach((branch) => {
    for (const r of branch.resourceResults.filter((x) => x.matched)) {
      const mres = branch.methodResults.find((m) => m.routeId === r.routeId);
      if (mres.allowed) methodSurvivors.push({ branch, route: branch.mount.routes.find((x) => x.id === r.routeId), resourceMatch: r });
    }
  });

  if (methodSurvivors.length === 0) {
    return finish(Reason.METHOD_NOT_ALLOWED, {
      status: 405,
      allow: explanation.methodAllow,
      evidence: {
        layer: 'method',
        message: `方法 ${method} 不被任何结构匹配的路由允许`,
        requested: method,
        allow: explanation.methodAllow,
        candidates: structurallyMatched.flatMap((b) =>
          b.resourceResults.filter((r) => r.matched).map((r) => r.ref)
        )
      }
    });
  }

  // ── W5 query 查询层查询（原始 query 收集，模拟查询层往返） ──────────────
  const queryReceipt = submit('query', 'query-layer-query', () => {
    const validEntries = parsed.queryEntries.filter((e) => !e.empty);
    const raw = {};
    for (const e of validEntries) {
      if (Object.prototype.hasOwnProperty.call(raw, e.key)) {
        raw[e.key] = Array.isArray(raw[e.key]) ? [...raw[e.key], e.rawValue] : [raw[e.key], e.rawValue];
      } else {
        raw[e.key] = e.rawValue;
      }
    }
    return {
      raw,
      refs: queryRefs(validEntries),
      entries: validEntries.map((e) => ({ key: e.key, rawValue: e.rawValue, index: e.index })),
      droppedEmpty: parsed.queryEntries.filter((e) => e.empty).map((e) => e.start)
    };
  }, { source: 'query-layer' });

  // ── W5 compute：服务端计算（每个方法存活候选，可与 query 查询乱序） ──────
  const computeFn = options.compute ?? null;
  const computeReceipts = methodSurvivors.map(({ branch, route }) =>
    submit('compute', 'server-compute', () => {
      if (typeof computeFn !== 'function') return { routeId: route.id, computed: {} };
      const computed = computeFn({
        app: branch.app.def,
        mount: branch.mount.def,
        route: route.def,
        request,
        parsed
      });
      return { routeId: route.id, computed: computed ?? {} };
    }, { routeId: route.id })
  );

  const { env: queryEnv } = await queryReceipt.receive();
  const queryRaw = queryEnv.value.raw;
  const queryRefMap = queryEnv.value.refs;
  explanation.decodedParamsView = {
    rawTarget: parsed.rawTarget,
    rawPath: parsed.rawPath,
    rawQuery: parsed.rawQuery,
    queryEntries: queryEnv.value.entries,
    host: parsed.host.normalized
  };

  for (const cr of computeReceipts) {
    const { env } = await cr.receive();
    if (!env.ok) {
      return finish(Reason.DECODE_FAILED, {
        status: 400,
        evidence: {
          layer: 'compute',
          stage: 'server-compute',
          routeId: cr.label.routeId,
          message: env.error.message
        },
        error: env.error.message
      });
    }
    explanation.serverCompute.push({ routeId: env.value.routeId, computed: env.value.computed, seq: env.seq });
    const owner = methodSurvivors.find(
      (s) => s.route.id === env.value.routeId
    );
    if (owner) owner.computed = env.value.computed;
  }

  // ── W6 ranking：跨分支统一排序（挂载得分 + 资源得分 + priority + order） ─
  const rankingReceipt = submit('ranking', 'rank-candidates', () => {
    const table = methodSurvivors.map(({ branch, route }) => ({
      ref: candidateRef(route, branch.mount.id, branch.app.id),
      mountSpecificity: branch.mount.pattern.specificity,
      routeSpecificity: route.pattern.specificity,
      priority: route.priority,
      routeOrder: route.routeOrder,
      score:
        branch.mount.pattern.specificity * 1e9 +
        route.pattern.specificity * 1e5 -
        route.priority * 100 +
        (1e4 - route.routeOrder)
    }));
    table.sort((a, b) => b.score - a.score);
    return table;
  }, { candidateCount: methodSurvivors.length });

  {
    const { env } = await rankingReceipt.receive();
    explanation.rankTable = env.value;
  }
  const winningRef = explanation.rankTable[0].ref;
  const winner = methodSurvivors.find(
    (s) =>
      s.route.id === winningRef.routeId &&
      s.branch.mount.id === winningRef.mountId &&
      s.branch.app.id === winningRef.appId
  );
  explanation.winner = winningRef;

  // ── W7 decode：四个作用域独立解码（参数隔离的核心） ─────────────────────
  const decodePlan = [
    {
      scope: 'app',
      rules: winner.branch.app.paramRules ?? [],
      raw: winner.branch.hostParams,
      refs: winner.branch.hostRefs
    },
    {
      scope: 'mount',
      rules: winner.branch.mount.paramRules ?? [],
      raw: winner.branch.mountRaw,
      refs: winner.branch.mountRefs
    },
    {
      scope: 'resource',
      rules: winner.route.paramRules ?? [],
      raw: winner.resourceMatch.rawParams,
      refs: winner.resourceMatch.refs
    },
    {
      scope: 'query',
      // 查询规则跨 resource -> mount -> app 级联：同名规则以更近的资源层为准
      rules: mergeQueryRules(
        winner.branch.app.queryRules ?? [],
        winner.branch.mount.queryRules ?? [],
        winner.route.queryRules ?? []
      ),
      raw: queryRaw,
      refs: queryRefMap
    }
  ];

  const decodeReceipts = decodePlan.map((plan) =>
    submit('decode', `decode-${plan.scope}`, () =>
      decodeLayer(plan.raw, plan.rules, plan.refs, plan.scope)
    , { scope: plan.scope, routeId: winner.route.id })
  );

  const decoded = {};
  const decodeFailures = [];
  for (const receipt of decodeReceipts) {
    const { env } = await receipt.receive();
    if (!env.ok) {
      decodeFailures.push({ scope: receipt.label.scope, stage: 'engine', message: env.error.message });
      continue;
    }
    decoded[receipt.label.scope] = env.value.params;
    decodeFailures.push(...env.value.failures);
  }

  explanation.finalParams = {
    winner: winningRef,
    scopes: {
      app: decoded.app ?? {},
      mount: decoded.mount ?? {},
      resource: decoded.resource ?? {},
      query: decoded.query ?? {}
    },
    computed: winner.computed ?? {},
    /** 同名参数按作用域分列，绝不合并成全局字典 */
    byName: null
  };
  explanation.finalParams.byName = buildByNameView(explanation.finalParams.scopes);

  if (decodeFailures.length > 0) {
    return finish(Reason.DECODE_FAILED, {
      status: 400,
      evidence: {
        layer: 'decode',
        failures: decodeFailures,
        winner: winningRef
      },
      error: decodeFailures.map((f) => `${f.scope}.${f.name ?? ''}:${f.message}`).join('; ')
    });
  }

  // ── W8 handler：处理器执行 ──────────────────────────────────────────────
  const handlerId = winner.route.handler;
  const handler = services.handlers?.get(handlerId);
  if (!handler) {
    return finish(Reason.HANDLER_REJECTED, {
      status: 500,
      evidence: {
        layer: 'handler',
        stage: 'registration',
        handlerId,
        routeId: winner.route.id,
        message: `处理器 "${handlerId}" 未注册`
      },
      error: `handler not registered: ${handlerId}`
    });
  }

  const handlerReceipt = submit('handler', 'invoke-handler', async () =>
    handler({
      app: winner.branch.app.def,
      mount: winner.branch.mount.def,
      route: winner.route.def,
      params: explanation.finalParams.scopes,
      computed: winner.computed ?? {},
      request,
      snapshotVersion: snapshot.version
    })
  , { handlerId, routeId: winner.route.id });

  const { env: handlerEnv } = await handlerReceipt.receive();
  if (!handlerEnv.ok) {
    const e = handlerEnv.error;
    const isRejection = e && e.name === 'HandlerRejection';
    return finish(Reason.HANDLER_REJECTED, {
      status: isRejection ? undefined : 500,
      evidence: {
        layer: 'handler',
        stage: isRejection ? 'internal-rejection' : 'crash',
        handlerId,
        routeId: winner.route.id,
        detail: e
      },
      error: e?.message ?? 'handler error'
    });
  }

  const output = handlerEnv.value;
  if (output && output.ok === false) {
    return finish(Reason.HANDLER_REJECTED, {
      status: output.status ?? 400,
      evidence: {
        layer: 'handler',
        stage: 'internal-rejection',
        handlerId,
        routeId: winner.route.id,
        code: output.code ?? 'REJECTED',
        detail: output.detail ?? null
      },
      error: output.message ?? 'handler rejected'
    });
  }

  return finish(Reason.MATCHED, {
    status: output?.status ?? 200,
    evidence: { layer: 'handler', handlerId, routeId: winner.route.id },
    output
  });
}

/**
 * 生成按名分列视图：同名参数出现在不同挂载层时保留为
 * { mountId/scope -> value } 的数组，便于证明隔离。
 */
function buildByNameView(scopes) {
  const byName = {};
  for (const [scope, kv] of Object.entries(scopes)) {
    for (const [name, value] of Object.entries(kv)) {
      const cell = { scope, value };
      if (!byName[name]) byName[name] = [];
      byName[name].push(cell);
    }
  }
  return byName;
}
