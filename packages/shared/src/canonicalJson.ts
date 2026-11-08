type JsonPrimitive = null | boolean | number | string;
export type CanonicalJson =
  | JsonPrimitive
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalize(value: unknown, seen: Set<object>): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Value is not canonical JSON");
  if (seen.has(value)) throw new TypeError("Canonical JSON cannot contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain objects");
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(record[key], seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeJson(value: unknown): CanonicalJson {
  return canonicalize(value, new Set());
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}
