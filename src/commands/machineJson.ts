/** JSON コマンドの stdout 契約: JSON object 1 個と LF のみ。 */
export function writeJsonObject(value: Record<string, unknown>, canonical = false): void {
  const output = canonical ? JSON.stringify(sortJsonKeys(value)) : JSON.stringify(value);
  process.stdout.write(`${output}\n`);
}

/** 全階層の object key を辞書順に並べる。配列の順序は意味を持つため維持する。 */
export function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortJsonKeys(source[key]);
  return sorted;
}
