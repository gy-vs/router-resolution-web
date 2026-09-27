import { RouterError } from "./errors.js";
import { deepFreeze, deepEqual } from "./util.js";

/**
 * Regression samples: a frozen copy of one explanation's input and expected
 * outcome, pinned to the snapshot version that produced it. Replaying a
 * sample re-runs the same request — against the pinned version (must
 * reproduce exactly) or against a newer version (produces a version diff).
 */

export class RegressionStore {
  #byId = new Map();
  #seq = 0;

  create({ explanation, name }) {
    this.#seq += 1;
    const t = explanation.trace;
    const sample = deepFreeze({
      id: `smp-${this.#seq}`,
      name: name ?? null,
      sourceExplanationId: explanation.id,
      pinnedVersion: explanation.version,
      request: t.request,
      expected: {
        classification: t.classification,
        winner: t.winner,
        params: t.params,
        allow: t.allow,
      },
      fingerprint: fingerprintOf(t),
    });
    this.#byId.set(sample.id, sample);
    return sample;
  }

  get(id) {
    const sample = this.#byId.get(id);
    if (!sample) {
      throw new RouterError("UNKNOWN_SAMPLE", `unknown regression sample "${id}"`);
    }
    return sample;
  }

  toJSON() {
    return { seq: this.#seq, items: [...this.#byId.values()] };
  }

  static fromJSON(data) {
    const store = new RegressionStore();
    store.#seq = data.seq;
    for (const item of data.items) {
      store.#byId.set(item.id, deepFreeze(item));
    }
    return store;
  }
}

/** Candidate-level outcome map used for version diffs. */
export function fingerprintOf(trace) {
  const mounts = {};
  for (const mc of trace.mountCandidates) {
    mounts[mc.refId] = mc.outcome === "kept" ? "kept" : `eliminated:${mc.reasonCode}`;
  }
  const routes = {};
  for (const rc of trace.routeCandidates) {
    routes[`${rc.mountRefId}/${rc.refId}`] =
      rc.outcome === "kept" ? "kept" : `eliminated:${rc.reasonCode}`;
  }
  return { mounts, routes };
}

/** Compare a sample's frozen expectation against a fresh explanation. */
export function diffSample(sample, explanation) {
  const t = explanation.trace;
  const diffs = [];
  const compare = (kind, expected, actual) => {
    if (!deepEqual(expected, actual)) diffs.push({ kind, expected, actual });
  };

  compare("classification", sample.expected.classification, t.classification);
  compare("winner", sample.expected.winner, t.winner);
  compare("params", sample.expected.params, t.params);
  compare("allow", sample.expected.allow, t.allow);

  const fp = fingerprintOf(t);
  for (const section of ["mounts", "routes"]) {
    const keys = new Set([
      ...Object.keys(sample.fingerprint[section]),
      ...Object.keys(fp[section]),
    ]);
    for (const key of keys) {
      const expected = sample.fingerprint[section][key];
      const actual = fp[section][key];
      if (expected !== actual) {
        diffs.push({
          kind: `candidate:${section}`,
          ref: key,
          expected: expected ?? "(absent)",
          actual: actual ?? "(absent)",
        });
      }
    }
  }

  return {
    sampleId: sample.id,
    request: sample.request,
    pinnedVersion: sample.pinnedVersion,
    replayedVersion: explanation.version,
    versionChanged: sample.pinnedVersion !== explanation.version,
    explanationId: explanation.id,
    same: diffs.length === 0,
    diffs,
  };
}
