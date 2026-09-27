import { RouterError } from "../core/errors.js";
import { SnapshotRegistry } from "../core/snapshot.js";
import {
  ExplanationStore,
  summaryView,
  layerTreeView,
  candidateDetailView,
} from "../core/explanation.js";
import { RegressionStore, diffSample } from "../core/regression.js";
import { explainRequest } from "../core/matcher.js";

/**
 * The server side of the workbench. Holds every loaded snapshot version
 * (immutable), every explanation it produced (pinned to the version that
 * created it), and every regression sample.
 *
 * All query methods are async: callers must treat responses as potentially
 * out-of-order and correlate them (see client/ExplanationWorkbench).
 */
export class RouteResolutionService {
  #registry = new SnapshotRegistry();
  #explanations = new ExplanationStore();
  #samples = new RegressionStore();

  /** Load and freeze a route snapshot. Returns its version id. */
  loadSnapshot(snapshot) {
    return this.#registry.load(snapshot);
  }

  /** Summary of every loaded snapshot version. */
  listSnapshots() {
    return this.#registry.list();
  }

  /**
   * Run the layered match. `version` pins the snapshot; when omitted the
   * latest loaded version is used — and recorded on the explanation, so the
   * result stays bound to that version for its whole lifetime.
   * Returns the bounded summary view.
   */
  async explain(request, { version, previewLimit } = {}) {
    const resolved = version ?? this.#registry.latest();
    const entry = this.#registry.get(resolved);
    const trace = explainRequest(entry.compiled, request);
    const explanation = this.#explanations.create({ version: resolved, trace });
    return summaryView(explanation, { previewLimit });
  }

  /** Re-fetch the summary of an existing explanation (still version-pinned). */
  async getSummary(explanationId) {
    return summaryView(this.#explanations.get(explanationId));
  }

  /** The full candidate tree as lightweight refs — no route definitions. */
  async getLayerTree(explanationId) {
    return layerTreeView(this.#explanations.get(explanationId));
  }

  /**
   * Full detail for one candidate. The route/mount definition is resolved
   * from the explanation's pinned snapshot version, so a detail view of an
   * in-flight explanation never observes a newer route table.
   */
  async getCandidateDetail(explanationId, candidateId) {
    const explanation = this.#explanations.get(explanationId);
    const pinned = this.#registry.get(explanation.version);
    return candidateDetailView(explanation, candidateId, pinned);
  }

  /** Copy an explanation into a frozen regression sample. */
  async createSample(explanationId, { name } = {}) {
    return this.#samples.create({
      explanation: this.#explanations.get(explanationId),
      name,
    });
  }

  async getSample(sampleId) {
    return this.#samples.get(sampleId);
  }

  /**
   * Re-run a sample's request. Defaults to the pinned version (must
   * reproduce exactly); pass `version` to replay against a different
   * snapshot and receive the version diff.
   */
  async replaySample(sampleId, { version } = {}) {
    const sample = this.#samples.get(sampleId);
    const target = version ?? sample.pinnedVersion;
    const summary = await this.explain(sample.request, { version: target });
    const explanation = this.#explanations.get(summary.explanationId);
    return diffSample(sample, explanation);
  }

  /** Serialize the whole server state (snapshots, explanations, samples). */
  exportState() {
    return {
      format: "router-resolution-web/state@1",
      snapshots: this.#registry.toJSON(),
      explanations: this.#explanations.toJSON(),
      samples: this.#samples.toJSON(),
    };
  }

  /**
   * Restore a service from exportState(). Ids and counters are preserved, so
   * restored explanations/samples continue the same data chain and new work
   * never collides with restored ids.
   */
  static restore(state) {
    if (state == null || state.format !== "router-resolution-web/state@1") {
      throw new RouterError("INVALID_STATE", "not a router-resolution-web state export");
    }
    const service = new RouteResolutionService();
    for (const record of state.snapshots) {
      service.#registry.load(record.snapshot);
    }
    service.#explanations = ExplanationStore.fromJSON(state.explanations);
    service.#samples = RegressionStore.fromJSON(state.samples);
    return service;
  }
}
