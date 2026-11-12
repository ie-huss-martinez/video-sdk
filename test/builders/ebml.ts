/** Builds EBML elements by hand, for tests of the front check. */
import { ascii, flatten, type Part } from "./isobmff.js";

/** An EBML size as an 8-byte vint, or the unknown size. */
function size(value: number | "unknown"): Uint8Array {
  if (value === "unknown") return Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let rest = value;
  for (let i = 7; i >= 1; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

function id(value: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.from(bytes);
}

/** An element: its id, its size (or `"unknown"`, or an override), then its contents. */
export function element(
  elementId: number,
  contents: Part = [],
  sizeOverride?: number | "unknown",
): Uint8Array {
  const body = flatten(contents);
  return flatten([id(elementId), size(sizeOverride ?? body.length), body]);
}

export const IDS = {
  EBML: 0x1a45dfa3,
  DOC_TYPE: 0x4282,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  CONTENT_ENCODINGS: 0x6d80,
  CONTENT_ENCODING: 0x6240,
  CONTENT_ENCRYPTION: 0x5035,
  CUES: 0x1c53bb6b,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
} as const;

/** A track entry, encrypted or not. */
export function trackEntry(encrypted = false): Uint8Array {
  return element(IDS.TRACK_ENTRY, [
    element(0xd7, Uint8Array.of(1)),
    ...(encrypted
      ? [
          element(IDS.CONTENT_ENCODINGS, [
            element(IDS.CONTENT_ENCODING, [
              element(IDS.CONTENT_ENCRYPTION, [element(0x47e1, Uint8Array.of(5))]),
            ]),
          ]),
        ]
      : []),
  ]);
}

/** A whole file: the EBML header with this DocType, then a Segment of the given children. */
export function ebmlFile(
  docType: string,
  children: Part,
  segmentSize?: number | "unknown",
): Uint8Array {
  return flatten([
    element(IDS.EBML, [element(IDS.DOC_TYPE, ascii(docType))]),
    element(IDS.SEGMENT, children, segmentSize),
  ]);
}
