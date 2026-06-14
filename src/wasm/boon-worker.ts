/// <reference lib="webworker" />

// Loads the boon WASM module inside a Web Worker so the heavy parse pass
// doesn't block the UI thread. The main thread sends a parse request with
// the demo bytes; the worker replies with the extracted data.

export type ParseRequest = {
  id: number;
  bytes: ArrayBuffer;
  sampleEvery: number;
};

export type ParseResponse =
  | { id: number; progress: true; tick: number; total: number }
  | {
      id: number;
      ok: true;
      header: unknown;
      players: unknown;
      positions: unknown;
      winner: number | null;
      summary: unknown;
    }
  | { id: number; ok: false; error: string };

interface BoonModule {
  default: () => Promise<unknown>;
  DemoParser: new (bytes: Uint8Array) => {
    fileHeader(): unknown;
    players(): unknown;
    playerPositions(
      sampleEvery: number,
      progress: (tick: number, total: number) => void,
    ): unknown;
    gameWinner(): number | null | undefined;
    summary(): unknown;
    free(): void;
  };
}

let modulePromise: Promise<BoonModule> | null = null;

function loadModule(): Promise<BoonModule> {
  if (!modulePromise) {
    // Let Vite bundle the wasm-pack glue + .wasm (emitted as hashed assets and
    // URL-rewritten). A /* @vite-ignore */ runtime import would skip bundling,
    // so the .wasm would be missing from the production build.
    modulePromise = import("./pkg/boon_wasm.js").then(async (mod) => {
      const m = mod as unknown as BoonModule;
      await m.default();
      return m;
    });
  }
  return modulePromise;
}

self.onmessage = async (e: MessageEvent<ParseRequest>) => {
  const { id, bytes, sampleEvery } = e.data;
  try {
    const mod = await loadModule();
    const parser = new mod.DemoParser(new Uint8Array(bytes));
    const header = parser.fileHeader();
    const players = parser.players();
    // The WASM parse calls this periodically; forward it to the main thread so
    // it can render a progress bar. Cheap — ~a couple hundred messages total.
    const onProgress = (tick: number, total: number) => {
      (self as unknown as Worker).postMessage({
        id,
        progress: true,
        tick,
        total,
      } satisfies ParseResponse);
    };
    const positions = parser.playerPositions(sampleEvery, onProgress);
    const winner = parser.gameWinner() ?? null;
    // Defensive: a malformed/absent post-match summary must not fail the whole
    // parse (the map/heatmap views don't depend on it).
    let summary: unknown = {
      snapshots: [],
      damage_sample_times: [],
      damage_matrix: [],
      damage_by_source: [],
    };
    try {
      summary = parser.summary();
    } catch {
      // keep the empty fallback
    }
    parser.free();
    const reply: ParseResponse = {
      id,
      ok: true,
      header,
      players,
      positions,
      winner,
      summary,
    };
    (self as unknown as Worker).postMessage(reply);
  } catch (err) {
    const reply: ParseResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
