// Shared helpers for parsing Deadlock's KV3 `.vdata` files.
//
// KV3 is Valve's JSON-like config format. The files we consume (abilities.vdata,
// heroes.vdata) are a single root object whose top-level keys are entry names
// (an ability subclass, a hero) and whose values are nested objects. We only
// ever need a few scalar fields out of each entry, so the parser walks the
// top level and hands each entry's raw body text to cheap field/regex lookups.

export interface Entry {
  name: string;
  body: string;
}

// Walk the top-level entries of a KV3 object, yielding each entry's name and
// the raw text of its body (between the matched `{ }`). Handles quoted
// strings, line and block comments, and arbitrary nesting depth.
export function* topLevelEntries(src: string): Generator<Entry> {
  let i = 0;

  // Skip to the first opening `{` (the root object).
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) return;
  i++;

  const skipTrivia = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ",") {
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/"))
          i++;
        i += 2;
        continue;
      }
      break;
    }
  };

  const readName = (): string | null => {
    if (i >= src.length) return null;
    if (src[i] === '"') {
      i++;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          s += src[i + 1];
          i += 2;
          continue;
        }
        s += src[i++];
      }
      i++;
      return s;
    }
    let s = "";
    while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) s += src[i++];
    return s.length ? s : null;
  };

  const skipBalancedBlock = (): string => {
    // Caller has just read past `{`. Returns the body text until the
    // matching `}` (exclusive), and leaves `i` past that `}`.
    const start = i;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/"))
          i++;
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\" && i + 1 < src.length) {
            i += 2;
            continue;
          }
          i++;
        }
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const body = src.slice(start, i);
          i++;
          return body;
        }
      }
      i++;
    }
    return src.slice(start, i);
  };

  while (true) {
    skipTrivia();
    if (i >= src.length || src[i] === "}") return;

    const name = readName();
    if (!name) {
      i++;
      continue;
    }
    skipTrivia();
    if (src[i] === "=") i++;
    skipTrivia();

    if (src[i] !== "{") {
      // Scalar value at top level — skip the rest of this line.
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    i++;
    const body = skipBalancedBlock();
    yield { name, body };
  }
}

// Pull the first scalar value of `field` out of an entry body. Returns the raw
// text after `=` (trimmed, surrounding quotes stripped), or null if absent.
// Works for both `m_HeroID = 1` and `m_strFoo = "bar"`.
export function field(body: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*([^\\n]+)`);
  const m = body.match(re);
  if (!m) return null;
  let v = m[1].trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

// Convert a panorama image reference into the URL the app serves. Source2Viewer
// exports `foo.psd` / `foo.png` as `foo_psd.png` / `foo_png.png` (the source
// extension becomes part of the filename); `scripts/build-images.ts` then
// optimizes each into a same-named `.webp`, which is what actually ships:
//   panorama:"file://{images}/items/weapon/foo.psd"  ->  /items/weapon/foo_psd.webp
//   panorama:"file://{images}/heroes/hornet_sm.png"  ->  /heroes/hornet_sm_png.webp
// Accepts either the full `panorama:"..."` value or the bare path. Returns null
// if no `{images}/...ext` reference is found.
export function imageUrlFromPanorama(value: string): string | null {
  const m = value.match(/\{images\}\/(.+?)\.([A-Za-z0-9]+)"?$/);
  if (!m) return null;
  return `/${m[1]}_${m[2]}.webp`;
}
