/**
 * router-resolution-web 公开模块入口。
 *
 * 调用方在此重复调用（resolve）、重放（replay/restore）、恢复（get/view），
 * 所有结果都能回溯到同一条数据链：
 *
 *   snapshot(version, fingerprint)
 *     -> layer jobs(jobId, seq)
 *       -> candidate refs(expand)
 *         -> final params(scope/name/ref)
 *           -> regression sample(boundVersion, fingerprints)
 */
export {
  Workbench,
  SnapshotStore,
  buildSnapshot,
  CorrelationBus,
  FIFOBackend,
  ControlledBackend,
  Reason,
  STATUS_BY_REASON,
  RoutingFailure,
  DecodeFailure,
  HandlerRejection,
  compilePathPattern,
  compileHostPattern,
  matchResourcePattern,
  matchMountPrefix,
  matchHost,
  parseTarget,
  DEFAULT_POLICY,
  decodeLayer,
  decoders,
  toSummary,
  toCompact,
  expandCandidate,
  expandLayer,
  toRegressionSample,
  fingerprintExpectation,
  diffSnapshots,
  replay,
  fingerprint
} from '../core/index.js';
