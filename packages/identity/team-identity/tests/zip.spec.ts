/**
 * The minimal ZIP writer.
 *
 * The archive is read back by an independent reader written here rather than by
 * the writer's own code, so the structure, the checksums, and the compression
 * method are all verified from the outside — which is also what an extraction
 * tool does. The end-to-end proof is separate: a real `Expand-Archive` run
 * against a downloaded package is recorded in the acceptance notes.
 */

import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ZipTooLargeError, buildZip, crc32 } from '../src/zip.ts'

const SIGNATURE_LOCAL = 0x04034b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_END = 0x06054b50

interface ReadEntry {
  readonly name: string
  readonly data: Buffer
  readonly method: number
  readonly flag: number
}

/**
 * Read an archive the way an extractor does: the end record names the directory,
 * the directory names every entry, and each entry's bytes are inflated by the
 * method its header declares.
 * @param archive - the bytes to read.
 * @returns every entry in directory order.
 */
function readZip(archive: Buffer): readonly ReadEntry[] {
  const end = archive.length - 22
  expect(archive.readUInt32LE(end), 'end of central directory').toBe(SIGNATURE_END)
  const total = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const entries: ReadEntry[] = []
  for (let index = 0; index < total; index += 1) {
    expect(archive.readUInt32LE(offset), 'central directory header').toBe(SIGNATURE_CENTRAL)
    const flag = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const checksum = archive.readUInt32LE(offset + 16)
    const compressed = archive.readUInt32LE(offset + 20)
    const plain = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const local = archive.readUInt32LE(offset + 42)
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    expect(archive.readUInt32LE(local), 'local file header').toBe(SIGNATURE_LOCAL)
    const localName = archive.readUInt16LE(local + 26)
    const localExtra = archive.readUInt16LE(local + 28)
    expect(archive.subarray(local + 30, local + 30 + localName).toString('utf8')).toBe(name)
    const start = local + 30 + localName + localExtra
    const raw = archive.subarray(start, start + compressed)
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    expect(data.length, 'uncompressed size').toBe(plain)
    expect(crc32(data), 'crc32').toBe(checksum)
    entries.push({ name, data, method, flag })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('a minimal zip writer', () => {
  it('round-trips one stored entry', () => {
    const archive = buildZip([{ name: 'work/a.txt', data: Buffer.from('hi'), modified: new Date('2026-01-02T03:04:06Z') }])
    const entries = readZip(archive)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('work/a.txt')
    expect(entries[0]?.data.toString('utf8')).toBe('hi')
    // Two bytes are never worth a deflate stream, so this one is stored.
    expect(entries[0]?.method).toBe(0)
    // Bit 11 tells an extractor the name is UTF-8.
    expect((entries[0]?.flag ?? 0) & 0x0800).toBe(0x0800)
  })

  it('compresses what is worth compressing and keeps every name intact', () => {
    const archive = buildZip([
      { name: 'work/报告 2026Q1.txt', data: Buffer.from('x'.repeat(5000)), modified: new Date() },
      { name: 'work/图表/销量趋势.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), modified: new Date() },
    ])
    const entries = readZip(archive)
    expect(entries.map(entry => entry.name)).toEqual(['work/报告 2026Q1.txt', 'work/图表/销量趋势.png'])
    expect(entries[0]?.method).toBe(8)
    expect(entries[0]?.data.toString('utf8')).toBe('x'.repeat(5000))
    // A four-byte file grows under deflate, so it is stored instead.
    expect(entries[1]?.method).toBe(0)
  })

  it('writes an empty archive when there is nothing to package', () => {
    expect(readZip(buildZip([]))).toEqual([])
  })

  it('handles an empty file and a binary payload', () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
    const entries = readZip(buildZip([
      { name: 'work/empty', data: Buffer.alloc(0), modified: new Date() },
      { name: 'work/bytes.bin', data: binary, modified: new Date() },
    ]))
    expect(entries[0]?.data.byteLength).toBe(0)
    expect(entries[1]?.data.equals(binary)).toBe(true)
  })

  it('refuses what would need zip64 instead of writing it wrong', () => {
    const many = Array.from({ length: 0x10000 }, (_, index) => ({
      name: `work/${index}`,
      data: Buffer.alloc(0),
      modified: new Date(),
    }))
    expect(() => buildZip(many)).toThrow(ZipTooLargeError)
  })
})
