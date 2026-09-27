/** Recursively freeze a plain-data object graph (snapshots, traces, samples). */
export function deepFreeze(value, seen = new Set()) {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key], seen);
    }
    Object.freeze(value);
  }
  return value;
}

/** Structural equality for plain JSON-shaped data. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual(a[key], b[key]));
}
