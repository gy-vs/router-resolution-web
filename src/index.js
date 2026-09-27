/**
 * Public module entry for router-resolution-web.
 *
 * Everything an acceptance harness needs is exported here:
 *   RouteResolutionService  -> server: snapshots, matching, samples, restore
 *   ExplanationWorkbench    -> client: race-safe layered exploration
 *   createDirectTransport   -> in-process transport between the two
 *   Classification          -> the five result classifications
 *   lookupParam             -> scoped parameter lookup ("mount:x"/"route:x")
 *   RouterError             -> typed errors with stable `code`
 */
export { RouterError } from "./core/errors.js";
export { Classification } from "./core/matcher.js";
export { SnapshotRegistry, validateSnapshot } from "./core/snapshot.js";
export { lookupParam } from "./core/params.js";
export { RouteResolutionService } from "./server/service.js";
export { ExplanationWorkbench, createDirectTransport } from "./client/workbench.js";
