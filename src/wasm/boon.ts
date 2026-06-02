import type { PositionsResult } from "@/components/map-view";
import type { PlayerInfo } from "@/components/player-roster";
import type { ParseRequest, ParseResponse } from "./boon-worker";

export interface ParsedDemo {
  header: unknown;
  players: PlayerInfo[];
  positions: PositionsResult;
  winner: number | null;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (v: ParsedDemo) => void;
    reject: (e: Error) => void;
    onProgress?: (tick: number, total: number) => void;
  }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./boon-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<ParseResponse>) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if ("progress" in msg) {
        p.onProgress?.(msg.tick, msg.total);
        return;
      }
      pending.delete(msg.id);
      if (msg.ok) {
        p.resolve({
          header: msg.header,
          players: msg.players as PlayerInfo[],
          positions: msg.positions as PositionsResult,
          winner: msg.winner,
        });
      } else {
        p.reject(new Error(msg.error));
      }
    };
  }
  return worker;
}

export function parseDemo(
  bytes: Uint8Array,
  sampleEvery: number,
  onProgress?: (tick: number, total: number) => void,
): Promise<ParsedDemo> {
  const w = getWorker();
  const id = nextId++;
  return new Promise<ParsedDemo>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const req: ParseRequest = {
      id,
      bytes: bytes.buffer as ArrayBuffer,
      sampleEvery,
    };
    // Transfer the buffer to avoid copying; the original Uint8Array is
    // consumed and shouldn't be used after this call.
    w.postMessage(req, [req.bytes]);
  });
}
