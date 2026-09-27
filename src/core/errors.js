/**
 * Typed error for every failure the kernel can raise. The `code` field is
 * stable and safe to assert on programmatically.
 */
export class RouterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}
