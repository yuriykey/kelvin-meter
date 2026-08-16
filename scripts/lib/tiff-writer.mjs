/**
 * A minimal TIFF writer, used only to build test fixtures.
 *
 * It exists so the DNG parser can be tested against real committed bytes in
 * both byte orders, rather than against objects handed to it in memory. It is
 * deliberately not part of the app bundle.
 */

export const TYPE = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  SRATIONAL: 10,
};

const TYPE_SIZE = {
  [TYPE.BYTE]: 1,
  [TYPE.ASCII]: 1,
  [TYPE.SHORT]: 2,
  [TYPE.LONG]: 4,
  [TYPE.RATIONAL]: 8,
  [TYPE.SRATIONAL]: 8,
};

/** Exact rational representation with a fixed denominator. */
const RATIONAL_DENOMINATOR = 1000000;

export function toRational(value) {
  return [Math.round(value * RATIONAL_DENOMINATOR), RATIONAL_DENOMINATOR];
}

/**
 * Value as the parser will read it back, i.e. after the rational round trip.
 * Fixtures record this rather than the input float, so expected values and
 * file contents can never drift apart.
 */
export function quantise(value) {
  return Math.round(value * RATIONAL_DENOMINATOR) / RATIONAL_DENOMINATOR;
}

export function entry(tag, type, values) {
  return { tag, type, values };
}

export function ascii(tag, text) {
  const codes = [];
  for (const char of text) codes.push(char.charCodeAt(0));
  codes.push(0);
  return { tag, type: TYPE.ASCII, values: codes };
}

function valueByteLength(item) {
  return item.values.length * TYPE_SIZE[item.type];
}

/**
 * Build a single-IFD TIFF. Entries are sorted by tag, as TIFF requires.
 *
 * @param {{tag:number,type:number,values:number[]}[]} entries
 * @param {{littleEndian?: boolean}} options
 */
export function buildTiff(entries, { littleEndian = true } = {}) {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);

  const HEADER_SIZE = 8;
  const ENTRY_SIZE = 12;
  const ifdSize = 2 + sorted.length * ENTRY_SIZE + 4;
  const ifdOffset = HEADER_SIZE;

  // External values follow the IFD, each aligned to an even offset as TIFF
  // requires for word-sized types.
  let cursor = ifdOffset + ifdSize;
  const layout = new Map();
  for (const item of sorted) {
    const length = valueByteLength(item);
    if (length <= 4) continue;
    if (cursor % 2 !== 0) cursor += 1;
    layout.set(item.tag, cursor);
    cursor += length;
  }

  const buffer = new ArrayBuffer(cursor);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d, false);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, ifdOffset, littleEndian);

  view.setUint16(ifdOffset, sorted.length, littleEndian);
  sorted.forEach((item, index) => {
    const at = ifdOffset + 2 + index * ENTRY_SIZE;
    view.setUint16(at, item.tag, littleEndian);
    view.setUint16(at + 2, item.type, littleEndian);
    view.setUint32(at + 4, item.values.length, littleEndian);

    const length = valueByteLength(item);
    if (length <= 4) {
      // Inline values sit left-aligned in the 4-byte value field.
      writeValues(view, at + 8, item, littleEndian);
    } else {
      const offset = layout.get(item.tag);
      view.setUint32(at + 8, offset, littleEndian);
      writeValues(view, offset, item, littleEndian);
    }
  });
  view.setUint32(ifdOffset + 2 + sorted.length * ENTRY_SIZE, 0, littleEndian);

  return bytes;
}

function writeValues(view, offset, item, littleEndian) {
  let at = offset;
  for (const value of item.values) {
    switch (item.type) {
      case TYPE.BYTE:
      case TYPE.ASCII:
        view.setUint8(at, value);
        at += 1;
        break;
      case TYPE.SHORT:
        view.setUint16(at, value, littleEndian);
        at += 2;
        break;
      case TYPE.LONG:
        view.setUint32(at, value, littleEndian);
        at += 4;
        break;
      case TYPE.RATIONAL: {
        const [numerator, denominator] = toRational(value);
        view.setUint32(at, numerator, littleEndian);
        view.setUint32(at + 4, denominator, littleEndian);
        at += 8;
        break;
      }
      case TYPE.SRATIONAL: {
        const [numerator, denominator] = toRational(value);
        view.setInt32(at, numerator, littleEndian);
        view.setInt32(at + 4, denominator, littleEndian);
        at += 8;
        break;
      }
      default:
        throw new Error(`Unsupported fixture type ${item.type}`);
    }
  }
}
