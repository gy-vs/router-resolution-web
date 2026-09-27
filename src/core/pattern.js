/**
 * Path pattern compilation and raw-segment matching.
 *
 * Matching is deliberately performed on the *raw, still percent-encoded*
 * path. Decoding is a separate, later stage (see params.js) so that an
 * encoded slash (`%2F`) never silently restructures the path during
 * candidate selection — it either stays inside one segment or fails the
 * decode stage with a precise reason.
 */

/**
 * Split a raw path into segments. The leading empty segment produced by the
 * leading slash is dropped; interior and trailing empty segments (duplicate
 * separators, trailing slash) are preserved so the matcher can report them.
 */
export function splitRawPath(rawPath) {
  if (rawPath === "" || rawPath === "/") return [];
  const parts = rawPath.split("/");
  if (parts[0] === "") parts.shift();
  return parts;
}

/**
 * Collapse interior empty segments (`/a//b` -> `a b`). A trailing empty
 * segment is preserved so trailing-slash strictness can still be evaluated.
 */
export function collapseEmptySegments(segments) {
  const out = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === "" && i !== segments.length - 1) continue;
    out.push(segments[i]);
  }
  return out;
}

const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/;

/**
 * Compile `/users/:id(\d+)` into a segment list of
 * `{type:"static",value}` and `{type:"param",name,regex}` entries.
 * Throws Error on malformed patterns; callers wrap with context.
 */
export function compilePattern(source) {
  if (typeof source !== "string" || !source.startsWith("/")) {
    throw new Error(`pattern must start with '/': ${String(source)}`);
  }
  const segments = splitRawPath(source).map((seg, index) => {
    if (seg === "") {
      throw new Error(`empty segment at position ${index} in pattern ${source}`);
    }
    if (seg.startsWith(":")) {
      const m = PARAM_RE.exec(seg);
      if (!m) {
        throw new Error(`invalid parameter segment "${seg}" in pattern ${source}`);
      }
      let regex = null;
      if (m[2] != null) {
        try {
          regex = new RegExp(`^(?:${m[2]})$`);
        } catch {
          throw new Error(`invalid parameter regex in "${seg}" of pattern ${source}`);
        }
      }
      return { type: "param", name: m[1], regex };
    }
    return { type: "static", value: seg };
  });
  return { source, segments };
}

function matchPositions(compiledSegments, segs, count) {
  const rawParams = {};
  for (let i = 0; i < count; i += 1) {
    const raw = segs[i];
    const pat = compiledSegments[i];
    if (raw === "") {
      return {
        matched: false,
        reasonCode: "EMPTY_SEGMENT",
        reason: `empty segment at position ${i} (duplicate separator)`,
      };
    }
    if (pat.type === "static") {
      if (raw !== pat.value) {
        return {
          matched: false,
          reasonCode: "STATIC_MISMATCH",
          reason: `segment ${i}: expected "${pat.value}", got "${raw}"`,
        };
      }
    } else {
      if (pat.regex && !pat.regex.test(raw)) {
        return {
          matched: false,
          reasonCode: "REGEX_MISMATCH",
          reason: `segment ${i}: "${raw}" does not match ${pat.regex}`,
        };
      }
      rawParams[pat.name] = raw;
    }
  }
  return { matched: true, rawParams };
}

/**
 * Match a mount-point prefix against the leading raw segments.
 * Returns `{matched, consumed, rawParams}` or `{matched:false, reasonCode, reason}`.
 */
export function matchPrefix(compiled, rawSegs) {
  const need = compiled.segments.length;
  if (rawSegs.length < need) {
    return {
      matched: false,
      reasonCode: "LENGTH_MISMATCH",
      reason: `prefix ${compiled.source} needs ${need} segment(s), got ${rawSegs.length}`,
    };
  }
  const m = matchPositions(compiled.segments, rawSegs, need);
  if (!m.matched) return m;
  return { matched: true, consumed: need, rawParams: m.rawParams };
}

/**
 * Match a route pattern against the remaining raw segments exactly.
 * `strictTrailingSlash: false` tolerates one trailing empty segment and
 * reports the normalization via `trailingNormalized`.
 */
export function matchSegments(compiled, rawSegs, { strictTrailingSlash = false } = {}) {
  let segs = rawSegs;
  let trailingNormalized = false;
  if (segs.length > 0 && segs[segs.length - 1] === "") {
    if (strictTrailingSlash) {
      return {
        matched: false,
        reasonCode: "TRAILING_SLASH_STRICT",
        reason: `trailing slash rejected by strict pattern ${compiled.source}`,
      };
    }
    segs = segs.slice(0, -1);
    trailingNormalized = true;
  }
  if (segs.length !== compiled.segments.length) {
    return {
      matched: false,
      reasonCode: "LENGTH_MISMATCH",
      reason: `pattern ${compiled.source} needs ${compiled.segments.length} segment(s), got ${segs.length}`,
    };
  }
  const m = matchPositions(compiled.segments, segs, segs.length);
  if (!m.matched) return m;
  return { matched: true, rawParams: m.rawParams, trailingNormalized };
}
