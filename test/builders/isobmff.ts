/** Builds ISOBMFF boxes by hand, for tests of the front check. */

export type Part = Uint8Array | readonly Part[];

function flatten(part: Part): Uint8Array {
  if (part instanceof Uint8Array) return part;
  const chunks = part.map(flatten);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export const ascii = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

export function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    view.setUint32(i * 4, value >>> 0);
  });
  return out;
}

export function i16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    view.setInt16(i * 2, value);
  });
  return out;
}

/** A box: a 32-bit size, its type, then its contents. `size` overrides the real size. */
export function box(type: string, contents: Part = [], size?: number): Uint8Array {
  const body = flatten(contents);
  return flatten([u32(size ?? body.length + 8), ascii(type), body]);
}

/** An edit list, version 0, from `[mediaTime, rateInteger]` pairs. */
export function elst(...edits: readonly (readonly [number, number])[]): Uint8Array {
  return box("elst", [
    u32(0, edits.length),
    ...edits.map(([mediaTime, rate]) => [u32(1_000, mediaTime), i16(rate, 0)]),
  ]);
}

/** A track with an optional edit list and one sample entry. */
export function trak(entry = "avc1", edits?: Uint8Array): Uint8Array {
  const stsd = box("stsd", [u32(0, 1), box(entry, new Uint8Array(78))]);
  return box("trak", [
    box("tkhd", new Uint8Array(84)),
    ...(edits ? [box("edts", edits)] : []),
    box("mdia", [box("mdhd", new Uint8Array(24)), box("minf", [box("stbl", [stsd])])]),
  ]);
}

/** A whole file: an `ftyp` with this major brand, then the given boxes. */
export function isoFile(brand: string, ...boxes: Uint8Array[]): Uint8Array {
  return flatten([box("ftyp", [ascii(brand), u32(0), ascii("isom")]), ...boxes]);
}

export { flatten };
