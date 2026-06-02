// Ambient stub so the dynamic import in boon.ts typechecks before
// `bun run wasm` has generated the real pkg output.
declare module "*/pkg/boon_wasm.js" {
  const mod: unknown;
  export default mod;
}
