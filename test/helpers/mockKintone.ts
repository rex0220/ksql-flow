/**
 * インメモリ kintone REST API エミュレータ。
 * createKintoneClient({ fetch }) / ランナーの HTTP 層に注入して結合テストに使う。
 * ネットワークは一切使わない（調査報告 §2 の決定事項）。
 */

export interface MockFieldDef {
  type: string;
  label?: string;
  unique?: boolean;
  required?: boolean;
  /** SUBTABLE の子フィールド */
  fields?: Record<string, MockFieldDef>;
}

export interface MockAppDef {
  id: number;
  name?: string;
  fields: Record<string, MockFieldDef>;
  records?: Array<Record<string, string>>;
  /** このアプリへのリクエストで要求される API トークン（カンマ結合済み文字列）。未指定なら検査しない */
  expectedToken?: string;
}

interface StoredRecord {
  id: number;
  revision: number;
  values: Record<string, string>;
}

interface FailureRule {
  times: number;
  status: number;
  retryAfterSec?: number;
  match?: (method: string, path: string) => boolean;
  body?: unknown;
  /** ネットワークエラー（fetch reject）にする */
  network?: boolean;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  appId?: number;
  token?: string;
  body?: unknown;
}

interface CursorState {
  appId: number;
  rows: StoredRecord[];
  fields?: string[];
  position: number;
}

export class MockKintone {
  private readonly apps = new Map<number, { def: MockAppDef; records: StoredRecord[]; nextId: number }>();
  private readonly cursors = new Map<string, CursorState>();
  private cursorSeq = 1;
  private readonly failures: FailureRule[] = [];
  readonly requests: RequestLogEntry[] = [];

  constructor(apps: MockAppDef[]) {
    for (const app of apps) {
      const records: StoredRecord[] = [];
      let nextId = 1;
      for (const values of app.records ?? []) {
        records.push({ id: nextId, revision: 1, values: { ...values } });
        nextId += 1;
      }
      this.apps.set(app.id, { def: app, records, nextId });
    }
  }

  app(id: number): { def: MockAppDef; records: StoredRecord[] } {
    const entry = this.apps.get(id);
    if (!entry) throw new Error(`MockKintone: app ${id} not defined`);
    return entry;
  }

  /** 次の n リクエストを失敗させる */
  failNext(rule: Partial<FailureRule> & { status?: number }): void {
    this.failures.push({
      times: rule.times ?? 1,
      status: rule.status ?? 500,
      retryAfterSec: rule.retryAfterSec,
      match: rule.match,
      body: rule.body,
      network: rule.network,
    });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const path = parsed.pathname;
    const headers = new Headers(init?.headers);
    const token = headers.get("X-Cybozu-API-Token") ?? undefined;
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    const search = parsed.searchParams;
    const appIdRaw = (body as { app?: unknown })?.app ?? search.get("app") ?? undefined;
    const appId = appIdRaw !== undefined && appIdRaw !== null ? Number(appIdRaw) : undefined;
    this.requests.push({ method, path, appId, token, body });

    for (const [index, rule] of this.failures.entries()) {
      if (rule.times > 0 && (rule.match === undefined || rule.match(method, path))) {
        rule.times -= 1;
        if (rule.times === 0) this.failures.splice(index, 1);
        if (rule.network) throw new TypeError("fetch failed (mock network error)");
        const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (rule.retryAfterSec !== undefined) responseHeaders["Retry-After"] = String(rule.retryAfterSec);
        return jsonResponse(rule.status, rule.body ?? { code: "MOCK", message: `mock failure ${rule.status}` }, responseHeaders);
      }
    }

    try {
      return this.route(method, path, search, body, token);
    } catch (error) {
      if (error instanceof MockApiError) {
        return jsonResponse(error.status, { code: error.code, message: error.message, errors: error.errors });
      }
      throw error;
    }
  };

  private route(method: string, path: string, search: URLSearchParams, body: unknown, token: string | undefined): Response {
    const m = `${method} ${path.replace(/^\/k\/guest\/\d+/, "/k")}`;
    switch (m) {
      case "GET /k/v1/records.json":
        return this.getRecords(search, token);
      case "POST /k/v1/records.json":
        return this.postRecords(body as { app: number; records: Array<Record<string, { value: unknown }>> }, token);
      case "PUT /k/v1/records.json":
        return this.putRecords(body as { app: number; records: Array<{ id: number; record: Record<string, { value: unknown }> }> }, token);
      case "DELETE /k/v1/records.json":
        return this.deleteRecords(body as { app: number; ids: number[] }, token);
      case "POST /k/v1/records/cursor.json":
        return this.createCursor(body as { app: number; query: string; size: number; fields?: string[] }, token);
      case "GET /k/v1/records/cursor.json":
        return this.readCursor(search.get("id") ?? "");
      case "DELETE /k/v1/records/cursor.json":
        return this.deleteCursor((body as { id: string }).id);
      case "GET /k/v1/app/form/fields.json":
        return this.getFields(Number(search.get("app")));
      case "GET /k/v1/app/settings.json":
        return jsonResponse(200, {
          numberPrecision: { digits: "16", decimalPlaces: "4", roundingMode: "HALF_EVEN" },
        });
      case "GET /k/v1/app/status.json":
        return jsonResponse(200, { enable: false, states: null });
      case "POST /k/v1/preview/app.json": {
        const name = (body as { name?: string }).name ?? "app";
        const id = Math.max(0, ...[...this.apps.keys()]) + 1;
        this.apps.set(id, { def: { id, name, fields: {} }, records: [], nextId: 1 });
        return jsonResponse(200, { app: String(id), revision: "1" });
      }
      case "POST /k/v1/preview/app/form/fields.json": {
        const request = body as { app: number; properties: Record<string, { type: string; label?: string; unique?: boolean }> };
        const entry = this.apps.get(Number(request.app));
        if (!entry) throw new MockApiError(404, "GAIA_AP01", `app ${request.app} not found`);
        for (const [code, property] of Object.entries(request.properties)) {
          entry.def.fields[code] = { type: property.type, label: property.label, unique: property.unique };
        }
        return jsonResponse(200, { revision: "2" });
      }
      case "POST /k/v1/preview/app/deploy.json":
        return jsonResponse(200, {});
      case "GET /k/v1/preview/app/deploy.json": {
        const appId = Number(search.get("apps[0]"));
        return jsonResponse(200, { apps: [{ app: String(appId), status: "SUCCESS" }] });
      }
      case "GET /k/v1/apps.json":
        return jsonResponse(200, {
          apps: [...this.apps.values()].map((entry) => ({
            appId: String(entry.def.id),
            name: entry.def.name ?? `app${entry.def.id}`,
            description: "",
          })),
        });
      default:
        throw new MockApiError(404, "GAIA_NF01", `MockKintone: unsupported endpoint ${m}`);
    }
  }

  private checkToken(appId: number, token: string | undefined): void {
    const entry = this.apps.get(appId);
    if (!entry) throw new MockApiError(404, "GAIA_AP01", `app ${appId} not found`);
    if (entry.def.expectedToken !== undefined && token !== entry.def.expectedToken) {
      throw new MockApiError(401, "CB_AU01", `invalid API token for app ${appId}: got ${token ?? "(none)"}`);
    }
  }

  private getRecords(search: URLSearchParams, token: string | undefined): Response {
    const appId = Number(search.get("app"));
    this.checkToken(appId, token);
    const entry = this.app(appId);
    const query = search.get("query") ?? "";
    const { rows } = applyQuery(entry.records, query, entry.def.fields);
    const fields = search.getAll("fields[]");
    const records = rows.map((row) => projectRecord(row, fields, entry.def.fields));
    const result: Record<string, unknown> = { records };
    if (search.get("totalCount") === "true") result.totalCount = String(rows.length);
    return jsonResponse(200, result);
  }

  private postRecords(body: { app: number; records: Array<Record<string, { value: unknown }>> }, token: string | undefined): Response {
    this.checkToken(body.app, token);
    const entry = this.apps.get(body.app)!;
    if (body.records.length > 100) throw new MockApiError(400, "CB_VA01", "records must be 100 or less");
    const created: StoredRecord[] = [];
    for (const record of body.records) {
      const values: Record<string, string> = {};
      for (const [code, item] of Object.entries(record)) {
        values[code] = normalizeValue(item.value);
      }
      this.enforceUnique(body.app, values, null);
      const stored: StoredRecord = { id: entry.nextId, revision: 1, values };
      entry.nextId += 1;
      entry.records.push(stored);
      created.push(stored);
    }
    return jsonResponse(200, { ids: created.map((row) => String(row.id)), revisions: created.map(() => "1") });
  }

  private putRecords(body: { app: number; records: Array<{ id: number; record: Record<string, { value: unknown }> }> }, token: string | undefined): Response {
    this.checkToken(body.app, token);
    const entry = this.apps.get(body.app)!;
    if (body.records.length > 100) throw new MockApiError(400, "CB_VA01", "records must be 100 or less");
    for (const update of body.records) {
      const stored = entry.records.find((row) => row.id === Number(update.id));
      if (!stored) throw new MockApiError(404, "GAIA_RE01", `record ${update.id} not found in app ${body.app}`);
      const next: Record<string, string> = { ...stored.values };
      for (const [code, item] of Object.entries(update.record)) {
        next[code] = normalizeValue(item.value);
      }
      this.enforceUnique(body.app, next, stored.id);
      stored.values = next;
      stored.revision += 1;
    }
    return jsonResponse(200, { records: body.records.map((row) => ({ id: String(row.id), revision: "2" })) });
  }

  private deleteRecords(body: { app: number; ids: number[] }, token: string | undefined): Response {
    this.checkToken(body.app, token);
    const entry = this.apps.get(body.app)!;
    for (const id of body.ids) {
      const index = entry.records.findIndex((row) => row.id === Number(id));
      if (index === -1) throw new MockApiError(404, "GAIA_RE01", `record ${id} not found in app ${body.app}`);
      entry.records.splice(index, 1);
    }
    return jsonResponse(200, {});
  }

  private enforceUnique(appId: number, values: Record<string, string>, selfId: number | null): void {
    const entry = this.apps.get(appId)!;
    for (const [code, def] of Object.entries(entry.def.fields)) {
      if (def.unique !== true) continue;
      const value = values[code];
      if (value === undefined || value === "") continue;
      const dup = entry.records.find((row) => row.id !== selfId && row.values[code] === value);
      if (dup) {
        throw new MockApiError(400, "CB_VA01", "入力内容が正しくありません。", {
          [`record.${code}.value`]: { messages: ["値がほかのレコードと重複しています。"] },
        });
      }
    }
  }

  private createCursor(body: { app: number; query: string; size: number; fields?: string[] }, token: string | undefined): Response {
    this.checkToken(body.app, token);
    const entry = this.app(body.app);
    const { rows } = applyQuery(entry.records, body.query ?? "", entry.def.fields);
    const id = `cursor-${this.cursorSeq++}`;
    this.cursors.set(id, { appId: body.app, rows, fields: body.fields, position: 0 });
    return jsonResponse(200, { id, totalCount: String(rows.length) });
  }

  private readCursor(id: string): Response {
    const cursor = this.cursors.get(id);
    if (!cursor) throw new MockApiError(400, "GAIA_CU01", `cursor ${id} not found`);
    const entry = this.app(cursor.appId);
    const page = cursor.rows.slice(cursor.position, cursor.position + 500);
    cursor.position += page.length;
    const next = cursor.position < cursor.rows.length;
    if (!next) this.cursors.delete(id);
    return jsonResponse(200, {
      records: page.map((row) => projectRecord(row, cursor.fields ?? [], entry.def.fields)),
      next,
    });
  }

  private deleteCursor(id: string): Response {
    this.cursors.delete(id);
    return jsonResponse(200, {});
  }

  private getFields(appId: number): Response {
    const entry = this.app(appId);
    const properties: Record<string, unknown> = {};
    for (const [code, def] of Object.entries(entry.def.fields)) {
      properties[code] = fieldProperty(code, def);
    }
    // 組み込みフィールド
    properties["$id"] = { code: "$id", label: "$id", type: "__ID__" };
    properties["レコード番号"] = properties["レコード番号"] ?? {
      code: "レコード番号",
      label: "レコード番号",
      type: "RECORD_NUMBER",
    };
    return jsonResponse(200, { properties });
  }
}

function fieldProperty(code: string, def: MockFieldDef): Record<string, unknown> {
  const property: Record<string, unknown> = {
    code,
    label: def.label ?? code,
    type: def.type,
  };
  if (def.unique === true) property.unique = true;
  if (def.required === true) property.required = true;
  if (def.type === "SUBTABLE" && def.fields) {
    const children: Record<string, unknown> = {};
    for (const [childCode, child] of Object.entries(def.fields)) {
      children[childCode] = fieldProperty(childCode, child);
    }
    property.fields = children;
  }
  return property;
}

function projectRecord(
  row: StoredRecord,
  fields: string[],
  defs: Record<string, MockFieldDef>
): Record<string, { value: string }> {
  const out: Record<string, { value: string }> = {};
  const include = (code: string) => fields.length === 0 || fields.includes(code);
  if (include("$id")) out["$id"] = { value: String(row.id) };
  if (include("$revision")) out["$revision"] = { value: String(row.revision) };
  if (include("レコード番号") ) out["レコード番号"] = { value: String(row.id) };
  for (const code of Object.keys(defs)) {
    if (!include(code)) continue;
    out[code] = { value: row.values[code] ?? "" };
  }
  // 保存されているが defs に無い値（テスト簡略化用）
  for (const [code, value] of Object.entries(row.values)) {
    if (out[code] === undefined && include(code)) out[code] = { value };
  }
  return out;
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

class MockApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: unknown
  ) {
    super(message);
  }
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// kintone クエリ評価器（テストで使う範囲のみ）
// ---------------------------------------------------------------------------

interface QueryResult {
  rows: StoredRecord[];
}

export function applyQuery(
  records: StoredRecord[],
  query: string,
  defs: Record<string, MockFieldDef>
): QueryResult {
  const trimmed = query.trim();
  let wherePart = trimmed;
  let orderPart = "";
  let limit: number | undefined;
  let offset = 0;

  const limitMatch = wherePart.match(/\blimit\s+(\d+)\s*$/i);
  if (limitMatch) {
    limit = Number(limitMatch[1]);
    wherePart = wherePart.slice(0, limitMatch.index).trim();
  }
  const offsetMatch = wherePart.match(/\boffset\s+(\d+)\s*$/i);
  if (offsetMatch) {
    offset = Number(offsetMatch[1]);
    wherePart = wherePart.slice(0, offsetMatch.index).trim();
  }
  const orderMatch = wherePart.match(/\border\s+by\s+(.+)$/i);
  if (orderMatch) {
    orderPart = orderMatch[1].trim();
    wherePart = wherePart.slice(0, orderMatch.index).trim();
  }

  let rows = records.slice();
  if (wherePart !== "") {
    const predicate = new QueryParser(wherePart, defs).parseOr();
    rows = rows.filter((row) => predicate(row));
  }
  if (orderPart !== "") {
    const keys = orderPart.split(",").map((part) => {
      const [field, dir] = part.trim().split(/\s+/);
      return { field, desc: (dir ?? "asc").toLowerCase() === "desc" };
    });
    rows.sort((a, b) => {
      for (const key of keys) {
        const av = fieldValue(a, key.field);
        const bv = fieldValue(b, key.field);
        const numeric = isNumericField(defs, key.field);
        let cmp: number;
        if (numeric) cmp = (Number(av) || 0) - (Number(bv) || 0);
        else cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return key.desc ? -cmp : cmp;
      }
      return 0;
    });
  }
  if (offset > 0) rows = rows.slice(offset);
  if (limit !== undefined) rows = rows.slice(0, limit);
  return { rows };
}

function fieldValue(row: StoredRecord, field: string): string {
  if (field === "$id" || field === "レコード番号") return String(row.id);
  if (field === "$revision") return String(row.revision);
  return row.values[field] ?? "";
}

function isNumericField(defs: Record<string, MockFieldDef>, field: string): boolean {
  if (field === "$id" || field === "$revision" || field === "レコード番号") return true;
  const def = defs[field];
  return def !== undefined && (def.type === "NUMBER" || def.type === "CALC");
}

type Predicate = (row: StoredRecord) => boolean;

class QueryParser {
  private pos = 0;
  constructor(private readonly text: string, private readonly defs: Record<string, MockFieldDef>) {}

  parseOr(): Predicate {
    let left = this.parseAnd();
    for (;;) {
      this.skipSpace();
      if (this.matchKeyword("or")) {
        const right = this.parseAnd();
        const l = left;
        left = (row) => l(row) || right(row);
      } else {
        return left;
      }
    }
  }

  private parseAnd(): Predicate {
    let left = this.parseTerm();
    for (;;) {
      this.skipSpace();
      if (this.matchKeyword("and")) {
        const right = this.parseTerm();
        const l = left;
        left = (row) => l(row) && right(row);
      } else {
        return left;
      }
    }
  }

  private parseTerm(): Predicate {
    this.skipSpace();
    if (this.peek() === "(") {
      // 括弧はグループにも in リストにも使われるため、条件グループとして先読み
      const save = this.pos;
      this.pos += 1;
      try {
        const inner = this.parseOr();
        this.skipSpace();
        if (this.peek() !== ")") throw new Error("expected )");
        this.pos += 1;
        return inner;
      } catch {
        this.pos = save;
      }
    }
    return this.parseComparison();
  }

  private parseComparison(): Predicate {
    this.skipSpace();
    const field = this.parseIdentifier();
    this.skipSpace();
    if (this.matchKeyword("not")) {
      this.skipSpace();
      if (this.matchKeyword("in")) {
        const values = this.parseValueList();
        return (row) => !values.includes(fieldValue(row, field));
      }
      if (this.matchKeyword("like")) {
        const value = this.parseValue();
        return (row) => !fieldValue(row, field).includes(value);
      }
      throw new Error(`MockKintone query: unsupported "not" operator near ${this.rest()}`);
    }
    if (this.matchKeyword("in")) {
      const values = this.parseValueList();
      return (row) => values.includes(fieldValue(row, field));
    }
    if (this.matchKeyword("like")) {
      const value = this.parseValue();
      return (row) => fieldValue(row, field).includes(value);
    }
    const op = this.parseOperator();
    const value = this.parseValue();
    const numeric = isNumericField(this.defs, field) || /^-?\d+(\.\d+)?$/.test(value);
    return (row) => {
      const raw = fieldValue(row, field);
      if (numeric) {
        const a = Number(raw === "" ? NaN : raw);
        const b = Number(value);
        switch (op) {
          case "=": return a === b;
          case "!=": return a !== b;
          case ">": return a > b;
          case "<": return a < b;
          case ">=": return a >= b;
          case "<=": return a <= b;
        }
      }
      switch (op) {
        case "=": return raw === value;
        case "!=": return raw !== value;
        case ">": return raw > value;
        case "<": return raw < value;
        case ">=": return raw >= value;
        case "<=": return raw <= value;
      }
      return false;
    };
  }

  private parseOperator(): "=" | "!=" | ">" | "<" | ">=" | "<=" {
    this.skipSpace();
    for (const op of ["!=", ">=", "<=", "=", ">", "<"] as const) {
      if (this.text.startsWith(op, this.pos)) {
        this.pos += op.length;
        return op;
      }
    }
    throw new Error(`MockKintone query: expected operator near ${this.rest()}`);
  }

  private parseValueList(): string[] {
    this.skipSpace();
    if (this.peek() !== "(") throw new Error(`MockKintone query: expected ( near ${this.rest()}`);
    this.pos += 1;
    const values: string[] = [];
    for (;;) {
      values.push(this.parseValue());
      this.skipSpace();
      if (this.peek() === ",") {
        this.pos += 1;
        continue;
      }
      if (this.peek() === ")") {
        this.pos += 1;
        return values;
      }
      throw new Error(`MockKintone query: expected , or ) near ${this.rest()}`);
    }
  }

  private parseValue(): string {
    this.skipSpace();
    const quote = this.peek();
    if (quote === '"' || quote === "'") {
      this.pos += 1;
      let value = "";
      while (this.pos < this.text.length) {
        const ch = this.text[this.pos];
        if (ch === "\\" && this.pos + 1 < this.text.length) {
          value += this.text[this.pos + 1];
          this.pos += 2;
          continue;
        }
        if (ch === quote) {
          this.pos += 1;
          return value;
        }
        value += ch;
        this.pos += 1;
      }
      throw new Error("MockKintone query: unterminated string");
    }
    const match = this.text.slice(this.pos).match(/^-?\d+(\.\d+)?/);
    if (match) {
      this.pos += match[0].length;
      return match[0];
    }
    throw new Error(`MockKintone query: expected value near ${this.rest()}`);
  }

  private parseIdentifier(): string {
    this.skipSpace();
    const match = this.text.slice(this.pos).match(/^[$\w.\u0080-\uffff-]+/);
    if (!match) throw new Error(`MockKintone query: expected field near ${this.rest()}`);
    this.pos += match[0].length;
    return match[0];
  }

  private matchKeyword(keyword: string): boolean {
    const slice = this.text.slice(this.pos, this.pos + keyword.length);
    const after = this.text[this.pos + keyword.length];
    if (slice.toLowerCase() === keyword && (after === undefined || /[\s("']/.test(after))) {
      this.pos += keyword.length;
      return true;
    }
    return false;
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos += 1;
  }

  private peek(): string | undefined {
    return this.text[this.pos];
  }

  private rest(): string {
    return this.text.slice(this.pos, this.pos + 30);
  }
}
