// 依存ライブラリなしの ZIP リーダー（ZIP64 / UTF-8 / Shift_JIS ファイル名対応）
// File.slice で必要な部分だけ読むので、大きな ZIP でもメモリを使いすぎない。

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

const utf8 = new TextDecoder('utf-8', { fatal: true });
let sjis = null;
try { sjis = new TextDecoder('shift_jis'); } catch { /* 未対応環境 */ }

function u64(dv, off) {
  return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;
}

function decodeName(bytes, isUtf8) {
  if (isUtf8) return new TextDecoder('utf-8').decode(bytes);
  try { return utf8.decode(bytes); } catch { /* UTF-8 ではない */ }
  if (sjis) return sjis.decode(bytes);
  return new TextDecoder('latin1').decode(bytes);
}

async function readBytes(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

export async function readZip(file) {
  const size = file.size;
  const tailLen = Math.min(size, 65535 + 22 + 20);
  const tailStart = size - tailLen;
  const tail = await readBytes(file, tailStart, size);

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP ファイルとして読み込めません');

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const off64 = u64(tail, loc + 8);
      const e64 = await readBytes(file, off64, off64 + 56);
      if (e64.getUint32(0, true) === SIG_EOCD64) {
        count = u64(e64, 32);
        cdSize = u64(e64, 40);
        cdOffset = u64(e64, 48);
      }
    }
  }

  const cd = await readBytes(file, cdOffset, cdOffset + cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== SIG_CDH) break;
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let uncompSize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);

    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    let name = decodeName(nameBytes, (flags & 0x800) !== 0);

    // extra fields
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      let q = e + 4;
      if (id === 0x0001) { // ZIP64
        if (uncompSize === 0xffffffff) { uncompSize = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
      } else if (id === 0x7075 && len > 5) { // Info-ZIP Unicode Path
        const b = new Uint8Array(cd.buffer, cd.byteOffset + e + 9, len - 5);
        try { name = new TextDecoder('utf-8').decode(b); } catch { /* ignore */ }
      }
      e += 4 + len;
    }
    p = eEnd + commentLen;

    name = name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (flags & 0x1) continue; // 暗号化は非対応

    entries.push({
      name,
      size: uncompSize,
      method,
      getBlob: (type = '') => extract(file, localOffset, compSize, method, type),
    });
  }
  return entries;
}

async function extract(file, localOffset, compSize, method, type) {
  const lh = await readBytes(file, localOffset, localOffset + 30);
  if (lh.getUint32(0, true) !== SIG_LFH) throw new Error('ZIP の構造が壊れています');
  const start = localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const raw = file.slice(start, start + compSize);
  if (method === 0) return new Blob([raw], { type });
  if (method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('この環境は圧縮 ZIP に対応していません（iPadOS 16.4 以降が必要）');
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return new Blob([buf], { type });
  }
  throw new Error(`未対応の圧縮形式です (method ${method})`);
}
