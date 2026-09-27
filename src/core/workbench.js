/**
 * 工作台门面：公开模块入口背后的编排者。
 *
 * 职责：
 *  - 持有 SnapshotStore（发布、版本冻结、淘汰）
 *  - 注册处理器（处理器不属于快照内容，快照只引用 handler id）
 *  - 每次 resolve 产出解释对象并保存（解释绑定 snapshotVersion，后续快照发布不影响它）
 *  - 提供视图投影、候选展开、回归样本/重放、解释恢复
 *  - 异步查询总线在此创建；默认 FIFO，可注入受控总线做竞态测试
 */
import { CorrelationBus, FIFOBackend } from './bus.js';
import { SnapshotStore } from './snapshot.js';
import { resolve } from './resolver.js';
import { Reason } from './errors.js';
import { toCompact, toSummary, expandCandidate, expandLayer } from './explanation.js';
import { toRegressionSample, replay, diffSnapshots } from './regression.js';

export class Workbench {
  /**
   * @param {object} [opts]
   * @param {object} [opts.bus] 自定义 CorrelationBus（测试注入受控后端）
   * @param {number} [opts.retention]
   */
  constructor(opts = {}) {
    this.snapshots = new SnapshotStore({ retention: opts.retention });
    this.bus = opts.bus ?? new CorrelationBus(new FIFOBackend());
    /** @type {Map<string,Function>} */
    this.handlers = new Map();
    /** @type {Map<string,object>} explanationId -> explanation */
    this.explanations = new Map();
    /** correlationId -> explanationId（总线调试入口） */
    this.byCorrelation = new Map();
  }

  /** 发布新路由树版本，返回版本元信息。 */
  publish(routeTree, meta = {}) {
    const snapshot = this.snapshots.publish(routeTree, meta);
    return {
      version: snapshot.version,
      fingerprint: snapshot.fingerprint,
      createdAt: snapshot.createdAt
    };
  }

  registerHandler(id, fn) {
    this.handlers.set(id, fn);
  }

  /**
   * 解析请求并保存解释。
   * @param {{method?:string,host?:string,target:string}} request
   * @param {object} [opts]
   * @param {string} [opts.version] 绑定指定快照版本；缺省为当前版本
   * @param {object} [opts.policy]
   * @param {Function} [opts.compute] 服务端计算函数
   * @param {string} [opts.correlationId]
   * @returns {Promise<object>} explanation
   */
  async resolve(request, opts = {}) {
    const version = opts.version ?? this.snapshots.current()?.version;
    const snapshot = this.snapshots.get(version);
    if (!snapshot) {
      const err = new Error(`快照版本 ${version ?? '(空)'} 不存在`);
      err.name = 'SnapshotUnknown';
      err.reason = Reason.SNAPSHOT_UNKNOWN;
      throw err;
    }
    const explanation = await resolve(snapshot, request, {
      bus: this.bus,
      handlers: this.handlers
    }, {
      policy: opts.policy,
      compute: opts.compute,
      correlationId: opts.correlationId
    });
    this.explanations.set(explanation.id, explanation);
    this.byCorrelation.set(explanation.correlationId, explanation.id);
    return explanation;
  }

  getExplanation(id) {
    return this.explanations.get(id) ?? null;
  }

  getByCorrelation(correlationId) {
    const id = this.byCorrelation.get(correlationId);
    return id ? this.explanations.get(id) ?? null : null;
  }

  /** 摘要视图（公开结果默认形态）。 */
  view(id) {
    const explanation = this.requireExplanation(id);
    return toSummary(explanation);
  }

  compact(id, opts = {}) {
    const explanation = this.requireExplanation(id);
    return toCompact(explanation, opts);
  }

  /** 展开单个候选的完整路由定义（按需投影）。 */
  expand(id, ref) {
    const explanation = this.requireExplanation(id);
    return expandCandidate(this.snapshots, explanation, ref);
  }

  /** 分页展开某层淘汰明细。 */
  expandEliminations(id, layer, page) {
    const explanation = this.requireExplanation(id);
    return expandLayer(explanation, layer, page);
  }

  sample(id, opts = {}) {
    const explanation = this.requireExplanation(id);
    return toRegressionSample(explanation, opts);
  }

  replay(sampleOrId) {
    const sample =
      typeof sampleOrId === 'string'
        ? this.sample(sampleOrId)
        : sampleOrId;
    return replay(this, sample);
  }

  diffVersions(fromVersion, toVersion = null) {
    const from = this.snapshots.get(fromVersion);
    if (!from) throw new Error(`版本 ${fromVersion} 不存在`);
    const to = toVersion ? this.snapshots.get(toVersion) : this.snapshots.current();
    return diffSnapshots(from, to);
  }

  /** 从序列化样本恢复一个解释会话（重放并登记）。 */
  async restore(sample) {
    const report = await this.replay(sample);
    if (report.explanation) {
      this.explanations.set(report.explanation.id, report.explanation);
      this.byCorrelation.set(report.explanation.correlationId, report.explanation.id);
    }
    return report;
  }

  requireExplanation(id) {
    const explanation = this.explanations.get(id);
    if (!explanation) throw new Error(`解释 ${id} 不存在或已回收`);
    return explanation;
  }
}
