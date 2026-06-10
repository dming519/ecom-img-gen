const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff)
}

function writeUint32(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

export function encodeZipText(value: string) {
  return new TextEncoder().encode(value)
}

export async function blobToZipBytes(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer())
}

export function createZip(entries: Array<{ name: string; data: Uint8Array }>) {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encodeZipText(entry.name)
    const crc = crc32(entry.data)
    const local: number[] = []
    writeUint32(local, 0x04034b50)
    writeUint16(local, 20)
    writeUint16(local, 0)
    writeUint16(local, 0)
    writeUint16(local, 0)
    writeUint16(local, 0)
    writeUint32(local, crc)
    writeUint32(local, entry.data.length)
    writeUint32(local, entry.data.length)
    writeUint16(local, name.length)
    writeUint16(local, 0)
    const localBytes = new Uint8Array([...local, ...name])
    chunks.push(localBytes, entry.data)

    const header: number[] = []
    writeUint32(header, 0x02014b50)
    writeUint16(header, 20)
    writeUint16(header, 20)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint32(header, crc)
    writeUint32(header, entry.data.length)
    writeUint32(header, entry.data.length)
    writeUint16(header, name.length)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint16(header, 0)
    writeUint32(header, 0)
    writeUint32(header, offset)
    central.push(new Uint8Array([...header, ...name]))
    offset += localBytes.length + entry.data.length
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end: number[] = []
  writeUint32(end, 0x06054b50)
  writeUint16(end, 0)
  writeUint16(end, 0)
  writeUint16(end, entries.length)
  writeUint16(end, entries.length)
  writeUint32(end, centralSize)
  writeUint32(end, offset)
  writeUint16(end, 0)

  const parts = [...chunks, ...central, new Uint8Array(end)].map((item) => item.buffer as ArrayBuffer)
  return new Blob(parts, { type: "application/zip" })
}
