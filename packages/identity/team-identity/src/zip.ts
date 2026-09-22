/**
 * A minimal ZIP writer, because this repository has no ZIP dependency.
 *
 * The search came first: no `archiver`, `yazl`, `jszip`, or `adm-zip` is in the
 * dependency graph, and the only `zlib` use anywhere is HTTP content encoding.
 * Pulling a package in for one route was judged worse than writing the format's
 * stored/deflated subset, so this file is deliberately small and deliberately
 * limited:
 *
 * - **no encryption** and **no ZIP64** — an entry of 4 GiB or more, or more than
 *   65535 entries, is refused rather than written wrong (see {@link ZipTooLargeError});
 * - **no data descriptors**: every size and CRC is known before the header is
 *   written, which is why entries are built in memory;
 * - UTF-8 names are marked with the language-encoding flag, so a Chinese file
 *   name survives the round trip through any modern extractor.
 *
 * Deflate is used only when it actually shrinks the entry: a tiny text file often
 * grows, and a stored entry is both smaller and cheaper to verify.
 *
 * @module @deepseek-ai/dsh-team-identity/zip
 */

import { deflateRawSync } from 'node:zlib'

/** One file to place in the archive. */
export interface ZipEntry {
  /** Path inside the archive, always with `/` separators. */
  readonly name: string
  readonly data: Buffer
  /** Timestamp recorded for the entry; extraction tools show it as the file's time. */
  readonly modified: Date
}

/** Thrown when an archive would need the ZIP64 format this writer does not emit. */
export class ZipTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipTooLargeError'
  }
}

/** Neither the archive nor one of its entries may reach 4 GiB. */
const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff

const SIGNATURE_LOCAL = 0x04034b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_END = 0x06054b50

/** Version 2.0: the oldest version that covers deflate. */
const VERSION_NEEDED = 20

/** Bit 11: the name is UTF-8, not the legacy OEM code page. */
const FLAG_UTF8_NAME = 0x0800

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/**
 * CRC-32 table, built once.
 *
 * The checksum is part of the format, and `node:zlib`'s own `crc32` is newer than
 * the Node versions this repository builds against, so it is computed here.
 */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * The CRC-32 every ZIP entry carries.
 * @param data - the entry's uncompressed bytes.
 * @returns the checksum as an unsigned 32-bit number.
 */
export function crc32(data: Buffer): number {
  let value = 0xffffffff
  for (const byte of data) {
    value = ((CRC_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8)) >>> 0
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * Convert a timestamp to the pair of 16-bit MS-DOS fields a ZIP header holds.
 *
 * The format predates 1980 being in the past: a date before it cannot be
 * represented and is clamped, which is what every writer does.
 * @param when - the entry's modification time.
 * @returns the packed time and date fields.
 */
function dosStamp(when: Date): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, when.getFullYear())
  return {
    // Seconds have two-second resolution in this format.
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (Math.floor(when.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  }
}

/**
 * Build one complete archive.
 *
 * Entries are written in the order given, each as a local header followed by its
 * bytes, then a central directory, then the end record. Nothing is streamed: the
 * sizes must be known to write a header without a data descriptor, so the whole
 * archive is assembled in memory.
 * @param entries - files to place in the archive.
 * @returns the archive's bytes.
 * @throws ZipTooLargeError when the input needs ZIP64.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipTooLargeError(`an archive of ${entries.length} entries needs zip64`)
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    if (name.length > 0xffff) throw new ZipTooLargeError(`the name of ${entry.name} is too long for zip`)
    if (entry.data.length > MAX_BYTES) throw new ZipTooLargeError(`${entry.name} is too large for zip`)
    const deflated = deflateRawSync(entry.data)
    // Storing a small entry is both smaller and cheaper to check than deflating it.
    const stored = deflated.length >= entry.data.length
    const body = stored ? entry.data : deflated
    const method = stored ? METHOD_STORE : METHOD_DEFLATE
    const checksum = crc32(entry.data)
    const { time, date } = dosStamp(entry.modified)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIGNATURE_LOCAL, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(FLAG_UTF8_NAME, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIGNATURE_CENTRAL, 0)
    central.writeUInt16LE(VERSION_NEEDED, 4)
    central.writeUInt16LE(VERSION_NEEDED, 6)
    central.writeUInt16LE(FLAG_UTF8_NAME, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    // Regular file, readable by everyone: what an extraction tool should create.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
    if (offset > MAX_BYTES) throw new ZipTooLargeError('this archive needs zip64')
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(SIGNATURE_END, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, end])
}
