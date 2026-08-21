import { LoggingConfig, ResolvedProfile } from "../config";

/**
 * 認証情報のマスキング（設計書 8.4 / 絶対条件 3）。
 * トークン・パスワードは構造的にログへ渡さない設計だが、外部由来のエラーメッセージ等に
 * 混入する可能性に備え、全ログ出力の直前で既知の秘密文字列を伏字化する（多重防壁）。
 */
export class SecretMasker {
  private readonly secrets: string[];

  constructor(profile: ResolvedProfile) {
    const secrets = new Set<string>();
    for (const app of Object.values(profile.apps)) {
      for (const token of app.tokens) if (token.length >= 8) secrets.add(token);
    }
    if (profile.auth.password !== undefined && profile.auth.password.length >= 4) {
      secrets.add(profile.auth.password);
    }
    if (profile.basicAuth?.password !== undefined && profile.basicAuth.password.length >= 4) {
      secrets.add(profile.basicAuth.password);
    }
    if (profile.clientCert?.password !== undefined && profile.clientCert.password.length >= 4) {
      secrets.add(profile.clientCert.password);
    }
    // 長い順に置換して部分一致の取りこぼしを防ぐ
    this.secrets = [...secrets].sort((a, b) => b.length - a.length);
  }

  mask(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join("***");
    }
    return out;
  }
}

/**
 * log_detail に記録する SQL からリテラル値を除去する（logging.stripLiterals。設計書 8.4）。
 * 文字列リテラルと数値リテラルを ? に置換する。コメントはそのまま。
 */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          // '' 形式のエスケープ
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += quote === '"' ? '"?"' : "?";
      continue;
    }
    if (/\d/.test(ch) && !/[\w$]/.test(out.slice(-1))) {
      while (index < sql.length && /[\d.]/.test(sql[index])) index += 1;
      out += "?";
      continue;
    }
    if (ch === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      out += end === -1 ? sql.slice(index) : sql.slice(index, end);
      index = end === -1 ? sql.length : end;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** logging.maskFields 指定フィールドの値を伏字化する（キー値等をログへ載せる箇所で使用） */
export function maskFieldValue(logging: LoggingConfig, field: string, value: string): string {
  return logging.maskFields.includes(field) ? "***" : value;
}
