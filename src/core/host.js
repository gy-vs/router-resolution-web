/**
 * Host normalization and host-condition matching.
 *
 * Host comparison is case-insensitive (RFC 4343): the request host is
 * lowercased, an optional port suffix and a single trailing dot are
 * stripped. The normalization is reported in the trace so a caller can see
 * that `API.Example.COM` and `api.example.com` produce the same candidate
 * set.
 */

export function normalizeHost(host) {
  if (host == null || host === "") return { host: null, changed: false };
  const original = String(host);
  let h = original.trim();
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (ipv6) {
    h = ipv6[1];
  } else {
    h = h.replace(/:\d+$/, "");
  }
  h = h.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return { host: h, changed: h !== original };
}

/**
 * Condition forms:
 *   undefined/null      -> any host
 *   "example.com"       -> exact (case-insensitive)
 *   "*.example.com"     -> any proper subdomain (not the bare apex)
 *   ["a.com", "*.b.com"]-> any of the listed conditions
 */
export function hostMatches(condition, host) {
  if (condition == null) return true;
  if (host == null) return false;
  const list = Array.isArray(condition) ? condition : [condition];
  return list.some((entry) => {
    const c = String(entry).toLowerCase();
    if (c.startsWith("*.")) {
      const suffix = c.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === c;
  });
}

export function formatHostCondition(condition) {
  if (condition == null) return "(any)";
  return Array.isArray(condition) ? condition.join(" | ") : String(condition);
}
