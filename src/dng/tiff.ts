/**
 * A small, defensive TIFF/DNG IFD reader.
 *
 * DNG is TIFF 6.0 with extra tags, so the container is just an IFD chain.
 * Only the metadata is walked; pixel data is never touched. Both byte orders
 * are supported, plus BigTIFF, which DNG 1.7 permits.
 *
 * Everything here treats the input as hostile: a file picked off a phone can
 * be truncated, corrupt or crafted. Every read is bounds-checked, IFD chains
 * are cycle-detected, and counts are capped, so a bad file produces a thrown
 * error rather than a hang or an out-of-range read.
 */

import { TIFF_TYPE, TIFF_TYPE_SIZE } from './tags.ts';

/** Guards against a crafted file claiming a billion-entry array. */
const MAX_VALUE_COUNT = 1 << 20;
const MAX_IFDS = 64;
const MAX_ENTRIES_PER_IFD = 4096;

export class TiffParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TiffParseError';
  }
}

export interface TiffEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Absolute offset of the value bytes within the file. */
  readonly valueOffset: number;
}

export interface Ifd {
  /** Offset this IFD was read from, for diagnostics. */
  readonly offset: number;
  readonly entries: ReadonlyMap<number, TiffEntry>;
  readonly nextOffset: number;
}

export class TiffReader {
  readonly littleEndian: boolean;
  readonly bigTiff: boolean;
  readonly firstIfdOffset: number;
  private readonly view: DataView;
  private readonly byteLength: number;

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength < 8) {
      throw new TiffParseError('File is too small to be a TIFF or DNG');
    }
    this.view = new DataView(buffer);
    this.byteLength = buffer.byteLength;

    const byteOrder = this.view.getUint16(0, false);
    if (byteOrder === 0x4949) this.littleEndian = true;
    else if (byteOrder === 0x4d4d) this.littleEndian = false;
    else {
      throw new TiffParseError(
        'Not a TIFF or DNG file (missing II/MM byte order marker)',
      );
    }

    const magic = this.view.getUint16(2, this.littleEndian);
    if (magic === 42) {
      this.bigTiff = false;
      this.firstIfdOffset = this.view.getUint32(4, this.littleEndian);
    } else if (magic === 43) {
      this.bigTiff = true;
      if (buffer.byteLength < 16) {
        throw new TiffParseError('BigTIFF header is truncated');
      }
      const offsetSize = this.view.getUint16(4, this.littleEndian);
      if (offsetSize !== 8) {
        throw new TiffParseError(`Unsupported BigTIFF offset size ${offsetSize}`);
      }
      this.firstIfdOffset = this.readOffset(8);
    } else {
      throw new TiffParseError(
        `Not a TIFF or DNG file (magic number ${magic}, expected 42 or 43)`,
      );
    }
  }

  private readOffset(at: number): number {
    if (!this.bigTiff) return this.view.getUint32(at, this.littleEndian);
    const value = this.view.getBigUint64(at, this.littleEndian);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TiffParseError('BigTIFF offset exceeds addressable range');
    }
    return Number(value);
  }

  private require(offset: number, length: number, what: string): void {
    if (offset < 0 || length < 0 || offset + length > this.byteLength) {
      throw new TiffParseError(
        `${what} reads past the end of the file (offset ${offset}, length ${length}, file ${this.byteLength})`,
      );
    }
  }

  readIfd(offset: number): Ifd {
    const countSize = this.bigTiff ? 8 : 2;
    const entrySize = this.bigTiff ? 20 : 12;
    const offsetSize = this.bigTiff ? 8 : 4;

    this.require(offset, countSize, 'IFD entry count');
    const rawCount = this.bigTiff
      ? this.readOffset(offset)
      : this.view.getUint16(offset, this.littleEndian);

    if (rawCount > MAX_ENTRIES_PER_IFD) {
      throw new TiffParseError(`IFD at ${offset} claims ${rawCount} entries`);
    }

    const entriesStart = offset + countSize;
    this.require(entriesStart, rawCount * entrySize + offsetSize, 'IFD body');

    const entries = new Map<number, TiffEntry>();
    for (let i = 0; i < rawCount; i++) {
      const at = entriesStart + i * entrySize;
      const tag = this.view.getUint16(at, this.littleEndian);
      const type = this.view.getUint16(at + 2, this.littleEndian);
      const count = this.bigTiff
        ? this.readOffset(at + 4)
        : this.view.getUint32(at + 4, this.littleEndian);
      const valueFieldAt = at + (this.bigTiff ? 12 : 8);

      const typeSize = TIFF_TYPE_SIZE[type];
      if (typeSize === undefined) {
        // Unknown types are skipped rather than fatal: TIFF is extensible and
        // vendors do invent private types.
        continue;
      }
      if (count > MAX_VALUE_COUNT) continue;

      const byteCount = count * typeSize;
      const valueOffset =
        byteCount <= offsetSize ? valueFieldAt : this.readOffset(valueFieldAt);

      entries.set(tag, { tag, type, count, valueOffset });
    }

    const nextOffset = this.readOffset(entriesStart + rawCount * entrySize);
    return { offset, entries, nextOffset };
  }

  /**
   * Every IFD reachable from the header, in priority order: IFD0 first, then
   * its SubIFDs, then the rest of the chain. DNG colour tags normally live in
   * IFD0, but some writers put a full tag set in the raw SubIFD instead.
   */
  readAllIfds(): Ifd[] {
    const found: Ifd[] = [];
    const visited = new Set<number>();
    const queue: number[] = [this.firstIfdOffset];

    while (queue.length > 0 && found.length < MAX_IFDS) {
      const offset = queue.shift()!;
      if (offset === 0 || visited.has(offset)) continue;
      visited.add(offset);

      let ifd: Ifd;
      try {
        ifd = this.readIfd(offset);
      } catch {
        // A broken sub-chain should not discard the IFDs already read.
        continue;
      }
      found.push(ifd);

      const subIfds = ifd.entries.get(330);
      if (subIfds) {
        try {
          for (const sub of this.getNumbers(subIfds)) queue.push(sub);
        } catch {
          /* malformed SubIFDs pointer; the other IFDs are still usable */
        }
      }
      const exif = ifd.entries.get(34665);
      if (exif) {
        try {
          queue.push(...this.getNumbers(exif));
        } catch {
          /* malformed Exif pointer */
        }
      }
      if (ifd.nextOffset !== 0) queue.push(ifd.nextOffset);
    }

    if (found.length === 0) {
      throw new TiffParseError('No readable IFD found in file');
    }
    return found;
  }

  /**
   * Entry values as numbers. RATIONAL and SRATIONAL are divided out, so a
   * caller never has to think about numerator/denominator pairs.
   */
  getNumbers(entry: TiffEntry): number[] {
    const typeSize = TIFF_TYPE_SIZE[entry.type];
    if (typeSize === undefined) {
      throw new TiffParseError(`Unsupported TIFF type ${entry.type}`);
    }
    this.require(entry.valueOffset, entry.count * typeSize, `Tag ${entry.tag} value`);

    const le = this.littleEndian;
    const out: number[] = [];
    for (let i = 0; i < entry.count; i++) {
      const at = entry.valueOffset + i * typeSize;
      switch (entry.type) {
        case TIFF_TYPE.BYTE:
        case TIFF_TYPE.UNDEFINED:
          out.push(this.view.getUint8(at));
          break;
        case TIFF_TYPE.SBYTE:
          out.push(this.view.getInt8(at));
          break;
        case TIFF_TYPE.SHORT:
          out.push(this.view.getUint16(at, le));
          break;
        case TIFF_TYPE.SSHORT:
          out.push(this.view.getInt16(at, le));
          break;
        case TIFF_TYPE.LONG:
          out.push(this.view.getUint32(at, le));
          break;
        case TIFF_TYPE.SLONG:
          out.push(this.view.getInt32(at, le));
          break;
        case TIFF_TYPE.RATIONAL: {
          const numerator = this.view.getUint32(at, le);
          const denominator = this.view.getUint32(at + 4, le);
          out.push(denominator === 0 ? 0 : numerator / denominator);
          break;
        }
        case TIFF_TYPE.SRATIONAL: {
          const numerator = this.view.getInt32(at, le);
          const denominator = this.view.getInt32(at + 4, le);
          out.push(denominator === 0 ? 0 : numerator / denominator);
          break;
        }
        case TIFF_TYPE.FLOAT:
          out.push(this.view.getFloat32(at, le));
          break;
        case TIFF_TYPE.DOUBLE:
          out.push(this.view.getFloat64(at, le));
          break;
        case TIFF_TYPE.LONG8:
        case TIFF_TYPE.IFD8:
          out.push(Number(this.view.getBigUint64(at, le)));
          break;
        case TIFF_TYPE.SLONG8:
          out.push(Number(this.view.getBigInt64(at, le)));
          break;
        case TIFF_TYPE.ASCII:
          out.push(this.view.getUint8(at));
          break;
        default:
          throw new TiffParseError(`Unhandled TIFF type ${entry.type}`);
      }
    }
    return out;
  }

  /** Entry value as a NUL-terminated ASCII string. */
  getString(entry: TiffEntry): string {
    this.require(entry.valueOffset, entry.count, `Tag ${entry.tag} string`);
    let text = '';
    for (let i = 0; i < entry.count; i++) {
      const code = this.view.getUint8(entry.valueOffset + i);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text.trim();
  }
}

/** Cheap check before committing to a full parse. */
export function looksLikeTiff(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  const view = new DataView(buffer);
  const order = view.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  const magic = view.getUint16(2, order === 0x4949);
  return magic === 42 || magic === 43;
}
