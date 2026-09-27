/**
 * 回归样本与版本差异。
 *
 * 样本把一次解释冻结成可复制的工件：原始输入、绑定版本、策略、
 * 期望指纹（终态/获胜者/参数/失败链）以及一份 compact 证据快照。
 * 在任意进程里用 workbench.replay(sample) 重放；当前快照版本不同时，
 * diffVersions 精确指出“候选集合/获胜者/参数/失败原因”哪里变了。
 */
import { resolve } from './resolver.js';
import { fingerprint, genId } from './identifiers.js';
import { Reason } from './errors.js';
import { toCompact, toSummary } from './explanation.js';

/** 把一次解释复制成回归样本（只含可移植数据，不持有运行时对象）。 */
export function toRegressionSample(explanation, opts = {}) {
  return {
    kind: 'router-resolution-regression-sample',
    sampleVersion: 1,
    id: `sample_${explanation.id}`,
    createdAt: new Date().toISOString(),
    note: opts.note ?? '',
    boundSnapshotVersion: explanation.snapshotVersion,
    boundSnapshotFingerprint: explanation.snapshotFingerprint,
    request: explanation.request,
    policy: explanation.policy,
    expect: fingerprintExpectation(explanation),
    evidenceSnapshot: opts.includeEvidence === false ? null : toCompact(explanation)
  };
}

/** 从解释中抽取稳定期望指纹（去掉时间、id 等易变字段）。 */
export function fingerprintExpectation(explanation) {
  const payload = {
    reason: explanation.reason,
    status: explanation.status,
    winner: explanation.winner,
    methodAllow: explanation.methodAllow,
    finalParams: explanation.finalParams?.scopes ?? null,
    failure: normalizeFailure(explanation),
    host: explanation.decodedParamsView?.host ?? null,
    normalization: (explanation.normalizationEvents ?? []).map((e) => e.type)
  };
  return { fingerprint: fingerprint(payload), payload };
}

function normalizeFailure(explanation) {
  if (!explanation.evidence || explanation.reason === Reason.MATCHED) return null;
  const ev = explanation.evidence;
  if (Array.isArray(ev.failures)) {
    return {
      layer: ev.layer,
      failures: ev.failures.map((f) => ({
        scope: f.scope,
        name: f.name,
        stage: f.stage,
        rule: f.rule
      }))
    };
  }
  return { layer: ev.layer, stage: ev.stage ?? null, code: ev.code ?? null };
}

/**
 * 比较两个版本快照的结构差异（指纹不足以解释“哪里变了”）。
 * @returns {{changed:boolean, added:object[], removed:object[], changedRoutes:object[], same:boolean}}
 */
export function diffSnapshots(fromSnapshot, toSnapshot) {
  const index = (snap) => {
    const map = new Map();
    for (const app of snap.apps) {
      for (const mount of app.mounts) {
        for (const route of mount.routes) {
          map.set(`${app.id}/${mount.id}/${route.id}`, {
            appId: app.id,
            mountId: mount.id,
            routeId: route.id,
            path: route.def.path,
            methods: route.methods,
            hostSig: (app.def.hosts ?? ['*']).slice().sort(),
            mountPath: mount.def.path,
            rulesSig: fingerprint({
              app: app.paramRules,
              mount: mount.paramRules,
              route: route.paramRules,
              query: route.queryRules
            })
          });
        }
      }
    }
    return map;
  };

  const a = index(fromSnapshot);
  const b = toSnapshot ? index(toSnapshot) : new Map();
  const added = [];
  const removed = [];
  const changedRoutes = [];

  for (const [key, val] of b) {
    if (!a.has(key)) added.push(val);
  }
  for (const [key, val] of a) {
    const other = b.get(key);
    if (!other) {
      removed.push(val);
      continue;
    }
    const diffs = {};
    if (val.path !== other.path) diffs.path = { from: val.path, to: other.path };
    if (JSON.stringify(val.methods) !== JSON.stringify(other.methods)) {
      diffs.methods = { from: val.methods, to: other.methods };
    }
    if (val.mountPath !== other.mountPath) diffs.mountPath = { from: val.mountPath, to: other.mountPath };
    if (val.rulesSig !== other.rulesSig) diffs.paramRules = true;
    if (JSON.stringify(val.hostSig) !== JSON.stringify(other.hostSig)) {
      diffs.hosts = { from: val.hostSig, to: other.hostSig };
    }
    if (Object.keys(diffs).length) changedRoutes.push({ ref: val, fields: diffs });
  }

  return {
    changed: added.length + removed.length + changedRoutes.length > 0,
    added,
    removed,
    changedRoutes,
    from: { version: fromSnapshot.version, fingerprint: fromSnapshot.fingerprint },
    to: toSnapshot ? { version: toSnapshot.version, fingerprint: toSnapshot.fingerprint } : null
  };
}

/**
 * 用当前工作台重放样本。
 * @param {object} workbench Workbench 实例
 * @param {object} sample toRegressionSample 产物
 * @returns {Promise<object>} ReplayReport
 */
export async function replay(workbench, sample) {
  const boundSnapshot = workbench.snapshots.get(sample.boundSnapshotVersion);
  const current = workbench.snapshots.current();

  let explanation;
  let versionError = null;
  try {
    explanation = await workbench.resolve(sample.request, {
      version: sample.boundSnapshotVersion,
      policy: sample.policy,
      // 每次重放都是独立关联：重复重放绝不复用上一次信箱里的信封
      correlationId: `replay_${genId('attempt')}`
    });
  } catch (err) {
    versionError = { name: err.name, message: err.message, reason: err.reason ?? null };
    explanation = null;
  }

  const actual = explanation ? fingerprintExpectation(explanation) : null;
  const expectationMatched = actual ? actual.fingerprint === sample.expect.fingerprint : false;

  return {
    sampleId: sample.id,
    boundVersion: sample.boundSnapshotVersion,
    boundAvailable: Boolean(boundSnapshot),
    currentVersion: current?.version ?? null,
    currentIsBound: current?.version === sample.boundSnapshotVersion,
    versionError,
    expectationMatched,
    expected: sample.expect,
    actual,
    expectationDiff: expectationMatched ? null : diffPayloads(sample.expect.payload, actual?.payload ?? null),
    versionDiff:
      boundSnapshot && current && current.version !== boundSnapshot.version
        ? diffSnapshots(boundSnapshot, current)
        : null,
    summary: explanation ? toSummary(explanation) : null,
    explanation
  };
}

function diffPayloads(expected, actual) {
  const out = {};
  const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  for (const key of keys) {
    const a = expected?.[key];
    const b = actual?.[key];
    if (fingerprint(a) !== fingerprint(b)) out[key] = { expected: a, actual: b };
  }
  return out;
}
