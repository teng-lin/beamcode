/**
 * TraceDiffer — produces human-readable diffs between translation input/output.
 *
 * Compares two objects (from, to) and returns an array of diff strings:
 * - Field added:    "+metadata.subtype: set_model"
 * - Field removed:  "-session_id"
 * - Field renamed:  "session_id → metadata.session_id"  (same value, different key)
 * - Field changed:  "type: set_model → configuration_change"
 * - Type changed:   "content: string → array"
 */

type FlatEntry = { path: string; value: unknown };

function flatten(obj: unknown, prefix = ""): FlatEntry[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== "object") return [{ path: prefix || "(root)", value: obj }];
  if (Array.isArray(obj)) {
    // For arrays, represent as type + length rather than expanding every index
    return [{ path: prefix || "(root)", value: obj }];
  }

  const entries: FlatEntry[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      entries.push(...flatten(value, path));
    } else {
      entries.push({ path, value });
    }
  }
  return entries;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string")
    return value.length > 50 ? `"${value.slice(0, 47)}..."` : `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
  return String(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Safe serialization key for value comparison — caps at 1KB to avoid perf issues on large values. */
function serializeKey(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value);
  const s = JSON.stringify(value);
  return s.length > 1024 ? s.slice(0, 1024) : s;
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    return serializeKey(a) === serializeKey(b);
  }
  return false;
}

export function diffObjects(from: unknown, to: unknown): string[] {
  const fromEntries = flatten(from);
  const toEntries = flatten(to);

  const fromMap = new Map(fromEntries.map((e) => [e.path, e.value]));
  const toMap = new Map(toEntries.map((e) => [e.path, e.value]));

  const diffs: string[] = [];

  // Index "to" values by serialized value for rename detection
  const toValueIndex = new Map<string, string[]>();
  for (const [path, value] of toMap) {
    const key = serializeKey(value);
    const arr = toValueIndex.get(key) ?? [];
    arr.push(path);
    toValueIndex.set(key, arr);
  }

  const renamedFromPaths = new Set<string>();
  const renamedToPaths = new Set<string>();

  // Detect renames: same value, different path, path not in both maps
  for (const [fromPath, fromValue] of fromMap) {
    if (toMap.has(fromPath)) continue; // Not removed → not a rename candidate
    const key = serializeKey(fromValue);
    const candidates = toValueIndex.get(key);
    if (!candidates) continue;
    for (const toPath of candidates) {
      if (fromMap.has(toPath)) continue; // This "to" path exists in from → not a rename target
      if (renamedToPaths.has(toPath)) continue; // Already matched
      renamedFromPaths.add(fromPath);
      renamedToPaths.add(toPath);
      diffs.push(`${fromPath} → ${toPath}`);
      break;
    }
  }

  // Removed fields (not renamed)
  for (const [path] of fromMap) {
    if (!toMap.has(path) && !renamedFromPaths.has(path)) {
      diffs.push(`-${path}`);
    }
  }

  // Added fields (not renamed)
  for (const [path, value] of toMap) {
    if (!fromMap.has(path) && !renamedToPaths.has(path)) {
      diffs.push(`+${path}: ${formatValue(value)}`);
    }
  }

  // Changed fields
  for (const [path, fromValue] of fromMap) {
    const toValue = toMap.get(path);
    if (toValue === undefined) continue; // Handled as removed
    if (valueEquals(fromValue, toValue)) continue;

    const fromType = typeName(fromValue);
    const toType = typeName(toValue);
    if (fromType !== toType) {
      diffs.push(`${path}: ${fromType} → ${toType}`);
    } else {
      diffs.push(`${path}: ${formatValue(fromValue)} → ${formatValue(toValue)}`);
    }
  }

  return diffs;
}
