import { EXIT } from "./types";

export type GracefulSignal = "SIGINT" | "SIGTERM" | "SIGBREAK";

export interface CancellationToken {
  readonly requested: boolean;
  readonly signal: GracefulSignal | null;
}

/** Executor の callback からエンジンの次 chunk 開始を止めるための内部例外。 */
export class CancelledError extends Error {
  constructor(readonly signal: GracefulSignal | null) {
    super(signal === null ? "実行をキャンセルしました" : `${signal} を受信したため実行をキャンセルしました`);
    this.name = "CancelledError";
  }
}

/**
 * 単一 run の実行中だけ signal handler を所有する。
 * 1 回目は cooperative cancel、2 回目は結果を出さず即時終了する。
 */
export async function withGracefulCancellation<T>(
  action: (token: CancellationToken) => Promise<T>
): Promise<T> {
  let signal: GracefulSignal | null = null;
  let signalCount = 0;
  const token: CancellationToken = {
    get requested() {
      return signal !== null;
    },
    get signal() {
      return signal;
    },
  };

  const handlers = new Map<GracefulSignal, () => void>();
  const supportedSignals: readonly GracefulSignal[] =
    process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  for (const name of supportedSignals) {
    const handler = (): void => {
      signalCount += 1;
      if (signalCount >= 2) {
        // forced termination: Execution Result / cleanup は保証しない。
        process.exit(EXIT.RUNTIME);
      }
      signal = name;
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }

  try {
    return await action(token);
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}
