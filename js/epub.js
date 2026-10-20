// EPUB（画像中心の固定レイアウト＝漫画向け）を読み込み、ページ画像の並びに変換する
import { readZip } from './zip.js';
import { mimeOf, isImageName } from './util.js';

function resolvePath(base, href) {
  const u = new URL(href, 'http://e/' + base);
  return decodeURIComponent(u.pathname.slice(1));
}

function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length && type !== 'text/html') {
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

function byTag(doc, tag) {
  const list = doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS('*', tag) : [];
  return list.length ? Array.from(list) : Array.from(doc.getElementsByTagName(tag));
}

export async function readEpub(file) {
  const entries = await readZip(file);
  const map = new Map();
  for (const e of entries) {
    map.set(e.name, e);
    try { map.set(decodeURIComponent(e.name), e); } catch { /* ignore */ }
  }
  const text = async (path) => {
    const e = map.get(path);
    if (!e) throw new Error(`EPUB 内に ${path} が見つかりません`);
    return (await e.getBlob()).text();
  };

  const container = parseXml(await text('META-INF/container.xml'));
  const rootfile = byTag(container, 'rootfile')[0];
  if (!rootfile) throw new Error('EPUB の構造を読み取れません');
  const opfPath = rootfile.getAttribute('full-path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = parseXml(await text(opfPath));

  const manifest = new Map();
  for (const item of byTag(opf, 'item')) {
    manifest.set(item.getAttribute('id'), {
      path: resolvePath(opfDir, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
    });
  }

  const spine = byTag(opf, 'spine')[0];
  const ppd = spine && spine.getAttribute('page-progression-direction');
  const titleEl = byTag(opf, 'title')[0];
  const title = titleEl ? titleEl.textContent.trim() : '';

  const imagePaths = [];
  const seen = new Set();
  const add = (path) => {
    if (!seen.has(path) && map.has(path) && isImageName(path)) { seen.add(path); imagePaths.push(path); }
  };

  for (const ref of spine ? byTag(spine, 'itemref') : []) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item) continue;
    if (item.type.startsWith('image/')) { add(item.path); continue; }
    if (!/html|xml|svg/.test(item.type)) continue;
    const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/') + 1) : '';
    let doc;
    try { doc = parseXml(await text(item.path), 'application/xhtml+xml'); } catch { continue; }
    for (const img of byTag(doc, 'img')) {
      const src = img.getAttribute('src');
      if (src) add(resolvePath(dir, src));
    }
    for (const im of byTag(doc, 'image')) {
      const href = im.getAttribute('xlink:href') || im.getAttribute('href') ||
        im.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href) add(resolvePath(dir, href));
    }
  }

  if (!imagePaths.length) {
    throw new Error('画像ページが見つかりません（文字中心の EPUB や DRM 付き EPUB には対応していません）');
  }

  return {
    title,
    direction: ppd === 'rtl' ? 'rtl' : ppd === 'ltr' ? 'ltr' : null,
    pages: imagePaths.map((p) => ({ name: p, getBlob: () => map.get(p).getBlob(mimeOf(p)) })),
  };
}
