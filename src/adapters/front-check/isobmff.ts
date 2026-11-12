import type { VideoFilePolicy } from "../../core/errors/video-limits.js";
import type { WindowReader } from "../bytes/window-reader.js";
import { malformed, refused } from "./errors.js";
import type { FrontCheck } from "./types.js";

/** A box header: where the box and its payload are, and its type. */
interface Box {
  readonly type: string;
  readonly start: number;
  readonly payload: number;
  readonly end: number;
}

/** Top-level types that may open a QuickTime file without an `ftyp` box. */
const QUICKTIME_LEADS = new Set(["moov", "mdat", "wide", "free", "skip"]);
/** Sample entries of encrypted tracks. */
const ENCRYPTED_ENTRIES = new Set(["encv", "enca", "encs", "enct"]);

const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const printable = (bytes: Uint8Array) => bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);

/**
 * Whether a file starts like ISOBMFF or QuickTime: a first box whose type is
 * `ftyp`, or one QuickTime files may start with.
 *
 * @internal
 */
export async function looksIsobmff(reader: WindowReader): Promise<boolean> {
  const head = await reader.bytes(4, 4);
  if (head.length < 4 || !printable(head)) return false;
  const type = text(head);
  return type === "ftyp" || QUICKTIME_LEADS.has(type);
}

/**
 * The front check for ISOBMFF and QuickTime (ADR 0001), before mediabunny
 * reads the file: it walks the top-level boxes and the few children below
 * `moov` that matter, bounding the index and refusing edit lists and
 * encryption the SDK doesn't support. Every size is checked against the
 * bytes that remain, and every loop advances.
 *
 * @internal
 */
export async function checkIsobmff(
  reader: WindowReader,
  policy: VideoFilePolicy,
  maxElements: number,
): Promise<FrontCheck> {
  let container: "mp4" | "mov" = "mov";
  let elements = 0;

  const header = async (offset: number, end: number, top: boolean): Promise<Box> => {
    elements += 1;
    if (elements > maxElements) throw malformed(container, "too-many-elements");
    const bytes = await reader.bytes(offset, 16);
    if (bytes.length < 8 || offset + 8 > end) throw malformed(container, "truncated");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = bytes.subarray(4, 8);
    if (top && !printable(type)) throw malformed(container, "box-size");
    let size = view.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (bytes.length < 16) throw malformed(container, "truncated");
      const large = view.getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed(container, "box-size");
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize) throw malformed(container, "box-size");
    if (offset + size > end) throw malformed(container, "truncated");
    return { type: text(type), start: offset, payload: offset + headerSize, end: offset + size };
  };

  /** Calls `visit` for each child box of `parent`, in order. */
  const children = async (parent: Box, from: number, visit: (box: Box) => Promise<void>) => {
    let offset = from;
    while (offset < parent.end) {
      const box = await header(offset, parent.end, false);
      await visit(box);
      offset = box.end;
    }
  };
  const child = async (parent: Box, type: string, from = parent.payload) => {
    let found: Box | undefined;
    await children(parent, from, async (box) => {
      if (box.type === type && found === undefined) found = box;
    });
    return found;
  };

  const checkEditList = async (elst: Box) => {
    const head = await reader.bytes(elst.payload, 8);
    if (head.length < 8) throw malformed(container, "truncated");
    const view = new DataView(head.buffer, head.byteOffset, 8);
    const version = view.getUint8(0);
    const count = view.getUint32(4);
    const entrySize = version === 1 ? 20 : 12;
    if (elst.payload + 8 + count * entrySize > elst.end) throw malformed(container, "box-size");
    const bytes = await reader.bytes(elst.payload + 8, count * entrySize);
    const entries = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let mediaEdits = 0;
    for (let index = 0; index < count; index += 1) {
      const at = index * entrySize;
      const empty =
        version === 1 ? entries.getBigInt64(at + 8) === -1n : entries.getInt32(at + 4) === -1;
      const rate = at + (version === 1 ? 16 : 8);
      if (empty) {
        // Only one empty edit, before the media, is a plain delay.
        if (index !== 0) throw refused(container, "edit-list");
        continue;
      }
      mediaEdits += 1;
      if (mediaEdits > 1 || entries.getInt16(rate) !== 1 || entries.getInt16(rate + 2) !== 0) {
        throw refused(container, "edit-list");
      }
    }
  };

  const checkSampleEntries = async (stsd: Box) => {
    // A full box header, an entry count, then one box per sample entry.
    await children(stsd, stsd.payload + 8, async (entry) => {
      if (ENCRYPTED_ENTRIES.has(entry.type)) throw refused(container, "encryption");
    });
  };

  const checkTrack = async (trak: Box) => {
    await children(trak, trak.payload, async (box) => {
      if (box.type === "edts") {
        const elst = await child(box, "elst");
        if (elst) await checkEditList(elst);
      } else if (box.type === "mdia") {
        const minf = await child(box, "minf");
        const stbl = minf && (await child(minf, "stbl"));
        const stsd = stbl && (await child(stbl, "stsd"));
        if (stsd) await checkSampleEntries(stsd);
      }
    });
  };

  const first = await header(0, reader.size, true);
  if (first.type === "ftyp") {
    const brand = await reader.bytes(first.payload, 4);
    container = text(brand) === "qt  " ? "mov" : "mp4";
  } else if (!QUICKTIME_LEADS.has(first.type)) {
    throw refused(container, "signature");
  }

  let indexSize = 0;
  let tracks = 0;
  let moov = false;
  let offset = 0;
  while (offset < reader.size) {
    const box = await header(offset, reader.size, true);
    if (box.type === "moov" || box.type === "moof") {
      indexSize += box.end - box.start;
      policy.check("maxIndexSize", indexSize);
    }
    if (box.type === "moov") {
      if (moov) throw malformed(container, "no-index");
      moov = true;
      await children(box, box.payload, async (inner) => {
        if (inner.type === "pssh") throw refused(container, "encryption");
        if (inner.type === "trak") {
          tracks += 1;
          await checkTrack(inner);
        }
      });
    }
    offset = box.end;
  }
  if (!moov) throw malformed(container, "no-index");
  if (tracks === 0) throw malformed(container, "no-tracks");
  return { container, family: "isobmff", indexSize, tracks };
}
