import crypto from "node:crypto";

// Sorted keys and no undefined, so the same search always serializes the same way.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

// The day is part of the key because every sweep starts tomorrow: the same
// request made yesterday covered different dates.
export function searchDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

export function requestKey(sourceId: string, identity: Record<string, unknown>, day: string): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical({ source: sourceId, day, identity })))
    .digest("hex");
}
