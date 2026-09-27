/** router-resolution-web 核心内核（无 HTTP 依赖，可独立使用）。 */
export { Workbench } from './workbench.js';
export { SnapshotStore, buildSnapshot } from './snapshot.js';
export {
  CorrelationBus,
  FIFOBackend,
  ControlledBackend
} from './bus.js';
export { Reason, STATUS_BY_REASON, RoutingFailure, DecodeFailure, HandlerRejection } from './errors.js';
export {
  compilePathPattern,
  compileHostPattern,
  matchResourcePattern,
  matchMountPrefix,
  matchHost
} from './patterns.js';
export { parseTarget, DEFAULT_POLICY, scanRawSegments } from './target.js';
export { decodeLayer, decoders } from './decode.js';
export { toSummary, toCompact, expandCandidate, expandLayer } from './explanation.js';
export {
  toRegressionSample,
  fingerprintExpectation,
  diffSnapshots,
  replay
} from './regression.js';
export { fingerprint, canonicalJSON, genId } from './identifiers.js';
