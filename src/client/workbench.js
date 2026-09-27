import { RouterError } from "../core/errors.js";

/**
 * Direct in-process transport. In a real deployment the transport would be
 * HTTP; the workbench only relies on `transport(method, params) -> Promise`,
 * so any transport — including one that deliberately reorders responses —
 * plugs in unchanged.
 */
export function createDirectTransport(service, { delay = 0 } = {}) {
  return async (method, params = {}) => {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    switch (method) {
      case "explain":
        return service.explain(params.request, params);
      case "getSummary":
        return service.getSummary(params.explanationId);
      case "getLayerTree":
        return service.getLayerTree(params.explanationId);
      case "getCandidateDetail":
        return service.getCandidateDetail(params.explanationId, params.candidateId);
      case "createSample":
        return service.createSample(params.explanationId, params);
      case "replaySample":
        return service.replaySample(params.sampleId, params);
      default:
        throw new RouterError("UNKNOWN_METHOD", `unknown transport method: ${method}`);
    }
  };
}

/**
 * Client-side workbench. Guards every view update against out-of-order
 * responses:
 *   - each explain() gets a monotonic sequence number; a response that
 *     arrives after a newer request was issued is discarded (and recorded);
 *   - layer-tree and candidate-detail responses are bound to the explanation
 *     they were requested for; if the current view moved on, they are
 *     discarded (and recorded).
 * Discarded responses stay visible in `view.discarded` as evidence.
 */
export class ExplanationWorkbench {
  #transport;
  #seq = 0;
  #current = null;
  #layers = null;
  #details = new Map();
  #discarded = [];
  #samples = new Map();
  #replays = [];

  constructor({ transport } = {}) {
    if (typeof transport !== "function") {
      throw new RouterError("INVALID_TRANSPORT", "workbench requires a transport function");
    }
    this.#transport = transport;
  }

  get view() {
    return {
      seq: this.#seq,
      current: this.#current,
      layers: this.#layers,
      details: Object.fromEntries(this.#details),
      discarded: [...this.#discarded],
      samples: [...this.#samples.values()],
      replays: [...this.#replays],
    };
  }

  /** Issue a new explanation request; stale responses are discarded. */
  async explain(request, options = {}) {
    this.#seq += 1;
    const seq = this.#seq;
    const summary = await this.#transport("explain", { ...options, request });
    if (seq !== this.#seq) {
      this.#discarded.push({
        kind: "explain",
        seq,
        explanationId: summary.explanationId,
        classification: summary.classification,
      });
      return { stale: true, seq };
    }
    this.#current = { seq, ...summary };
    this.#layers = null;
    this.#details = new Map();
    return { stale: false, seq, summary };
  }

  /** Expand the layer tree for the current explanation. */
  async expandLayers() {
    const current = this.#requireCurrent();
    const tree = await this.#transport("getLayerTree", {
      explanationId: current.explanationId,
    });
    if (this.#current == null || this.#current.explanationId !== current.explanationId) {
      this.#discarded.push({ kind: "layers", explanationId: current.explanationId });
      return { stale: true };
    }
    this.#layers = tree;
    return { stale: false, tree };
  }

  /** Expand one candidate of the current explanation to full detail. */
  async expandCandidate(candidateId) {
    const current = this.#requireCurrent();
    const detail = await this.#transport("getCandidateDetail", {
      explanationId: current.explanationId,
      candidateId,
    });
    if (this.#current == null || this.#current.explanationId !== current.explanationId) {
      this.#discarded.push({
        kind: "candidate",
        explanationId: current.explanationId,
        candidateId,
      });
      return { stale: true };
    }
    this.#details.set(candidateId, detail);
    return { stale: false, detail };
  }

  /** Copy the current explanation into a regression sample. */
  async pinAsSample(name) {
    const current = this.#requireCurrent();
    const sample = await this.#transport("createSample", {
      explanationId: current.explanationId,
      name,
    });
    this.#samples.set(sample.id, sample);
    return sample;
  }

  /** Replay a sample; results are recorded independently of the live view. */
  async replaySample(sampleId, version) {
    const replay = await this.#transport("replaySample", { sampleId, version });
    this.#replays.push(replay);
    return replay;
  }

  #requireCurrent() {
    if (this.#current == null) {
      throw new RouterError(
        "NO_CURRENT_EXPLANATION",
        "no current explanation; call explain() first",
      );
    }
    return this.#current;
  }
}
