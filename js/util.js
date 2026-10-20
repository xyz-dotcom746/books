// 共通ユーティリティ

const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', jxl: 'image/jxl',
};

export function extOf(name) {
  const m = /\.([^./]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(path) {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function dirName(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function stripExt(name) {
  return name.replace(/\.[^./]+$/, '');
}

export function isImageName(name) {
  return extOf(name) in IMAGE_TYPES;
}

export function mimeOf(name) {
  return IMAGE_TYPES[extOf(name)] || '';
}

// macOS の隠しファイルや Windows のサムネイルキャッシュなどを除外
export function isJunk(path) {
  return /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(path) || /(^|\/)\._/.test(path) || /(^|\/)\./.test(path);
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
export function naturalCompare(a, b) {
  return collator.compare(a.normalize('NFKC'), b.normalize('NFKC'));
}

// 「漫画A 第1巻」「漫画A (01)」「漫画A vol.3」などから作品名を推定
export function guessSeriesTitle(volumeTitle) {
  const t = volumeTitle.normalize('NFKC').trim();
  const stripped = t
    .replace(/[\s_\-]*(第?\s*\d+\s*(巻|話|集)?|vol\.?\s*\d+|v\d+|\(\s*\d+\s*\)|\[\s*\d+\s*\]|[上中下前後]巻?)\s*$/i, '')
    .trim();
  return stripped || volumeTitle;
}

// 画像のヘッダーから縦横サイズを取得（全体をデコードしないので高速）
export async function imageSize(blob) {
  try {
    const dv = new DataView(await blob.slice(0, 512 * 1024).arrayBuffer());
    const r = parseSize(dv);
    if (r) return r;
  } catch { /* fallthrough */ }
  return decodeSize(blob);
}

function parseSize(dv) {
  const len = dv.byteLength;
  if (len < 30) return null;
  // PNG
  if (dv.getUint32(0) === 0x89504e47) return { w: dv.getUint32(16), h: dv.getUint32(20) };
  // GIF
  if (dv.getUint32(0) === 0x47494638) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  // BMP
  if (dv.getUint16(0) === 0x424d) return { w: dv.getInt32(18, true), h: Math.abs(dv.getInt32(22, true)) };
  // WebP
  if (dv.getUint32(0) === 0x52494646 && dv.getUint32(8) === 0x57454250) {
    const chunk = dv.getUint32(12);
    if (chunk === 0x56503820) return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    if (chunk === 0x5650384c) {
      const b = dv.getUint32(21, true);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 0x56503858) {
      const u24 = (o) => dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
      return { w: u24(24) + 1, h: u24(27) + 1 };
    }
    return null;
  }
  // JPEG
  if (dv.getUint16(0) === 0xffd8) {
    let off = 2;
    let orientation = 1;
    while (off + 9 < len) {
      if (dv.getUint8(off) !== 0xff) { off++; continue; }
      const marker = dv.getUint8(off + 1);
      if (marker === 0xff) { off++; continue; }
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { off += 2; continue; }
      const segLen = dv.getUint16(off + 2);
      if (marker === 0xe1) orientation = exifOrientation(dv, off + 4, segLen - 2) || orientation;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = dv.getUint16(off + 5), w = dv.getUint16(off + 7);
        return orientation >= 5 ? { w: h, h: w } : { w, h };
      }
      off += 2 + segLen;
    }
  }
  return null;
}

function exifOrientation(dv, start, length) {
  try {
    if (dv.getUint32(start) !== 0x45786966) return 0; // "Exif"
    const t = start + 6;
    const le = dv.getUint16(t) === 0x4949;
    const ifd = t + dv.getUint32(t + 4, le);
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > start + length) break;
      if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le);
    }
  } catch { /* ignore */ }
  return 0;
}

function decodeSize(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

// 表紙サムネイルを作成
export function makeThumb(blob, width = 320) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, width / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => resolve(b), 'image/jpeg', 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatBytes(n) {
  if (!n && n !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
