/**
 * Minimal ZIP writer and reader — zero dependencies.
 *
 * Implements the subset of PKZIP (APPNOTE.TXT) needed for archive export:
 * STORE method (no compression), local file headers, and a central directory.
 * Uncompressed entries keep the implementation small and auditable, and the
 * payloads here are JSON/CSV/Markdown that a transport layer will gzip anyway.
 *
 * Produces archives that open natively in macOS Finder, Windows Explorer,
 * `unzip`, and every standard library ZIP reader.
 */

/** CRC-32 lookup table (IEEE 802.3 polynomial, reversed: 0xEDB88320). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
  /** Modification time. Defaults to now. */
  date?: Date;
}

/** Encode a Date into the DOS time/date pair ZIP uses (2-second resolution). */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: dosDate };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
  }

  bytes(data: Uint8Array): void {
    this.push(data);
  }

  private push(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  get offset(): number {
    return this.length;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let position = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, position);
      position += chunk.length;
    }
    return out;
  }
}

/** Build a ZIP archive from a list of entries. */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const writer = new ByteWriter();
  const central: Array<{
    name: Uint8Array;
    crc: number;
    size: number;
    offset: number;
    time: number;
    date: number;
  }> = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.date ?? new Date());
    const offset = writer.offset;

    // ---- Local file header ----
    writer.u32(0x04034b50);
    writer.u16(20); // version needed to extract (2.0)
    // Bit 11 marks the filename as UTF-8, so non-ASCII names survive.
    writer.u16(0x0800);
    writer.u16(0); // method: 0 = stored
    writer.u16(time);
    writer.u16(date);
    writer.u32(crc);
    writer.u32(data.length); // compressed size
    writer.u32(data.length); // uncompressed size
    writer.u16(nameBytes.length);
    writer.u16(0); // extra field length
    writer.bytes(nameBytes);
    writer.bytes(data);

    central.push({ name: nameBytes, crc, size: data.length, offset, time, date });
  }

  // ---- Central directory ----
  const centralStart = writer.offset;
  for (const record of central) {
    writer.u32(0x02014b50);
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0x0800);
    writer.u16(0);
    writer.u16(record.time);
    writer.u16(record.date);
    writer.u32(record.crc);
    writer.u32(record.size);
    writer.u32(record.size);
    writer.u16(record.name.length);
    writer.u16(0); // extra
    writer.u16(0); // comment
    writer.u16(0); // disk number
    writer.u16(0); // internal attributes
    writer.u32(0o644 << 16); // external attributes: unix rw-r--r--
    writer.u32(record.offset);
    writer.bytes(record.name);
  }
  const centralSize = writer.offset - centralStart;

  // ---- End of central directory ----
  writer.u32(0x06054b50);
  writer.u16(0); // this disk
  writer.u16(0); // disk with central directory
  writer.u16(central.length);
  writer.u16(central.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0); // comment length

  return writer.finish();
}

export interface ZipReadEntry {
  name: string;
  data: Uint8Array;
  text(): string;
}

/**
 * Read a ZIP archive.
 *
 * Handles STORE entries directly. DEFLATE entries are inflated via
 * `DecompressionStream`, available in Node 18+ and modern browsers, so archives
 * produced by other tools can still be imported.
 */
export async function readZip(buffer: Uint8Array): Promise<ZipReadEntry[]> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const decoder = new TextDecoder();

  // Locate the end-of-central-directory record by scanning backwards for its
  // signature — it sits at the very end unless there's a trailing comment.
  let eocd = -1;
  const scanLimit = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= scanLimit; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a valid ZIP archive: end-of-central-directory record not found');

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipReadEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));

    // The local header's extra field length can differ from the central one.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new Error(`unsupported ZIP compression method ${method} for entry "${name}"`);
    }

    // Skip directory entries.
    if (!name.endsWith('/')) {
      entries.push({ name, data, text: () => new TextDecoder().decode(data) });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DEFLATE entries require DecompressionStream, which is unavailable in this runtime');
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });

  // `DecompressionStream.writable` is declared as accepting `BufferSource`, which
  // is wider than the `Uint8Array` this source emits, so the transform pair does
  // not unify structurally. The runtime contract is correct; only the declaration
  // is loose. The cast is written structurally rather than via `ReadableWritablePair`
  // so it compiles both with and without the DOM lib.
  const transform = new DecompressionStream('deflate-raw') as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };

  const inflated = source.pipeThrough(transform);
  const reader = inflated.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  const out = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}
