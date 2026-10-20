// EPUB の読み込み
//   - 全ページが画像だけの EPUB（漫画）→ 画像ページの並びに変換（見開き表示などが使える）
//   - 文章を含む EPUB（小説など）→ テキストモードで表示（js/epubview.js）
import { readZip } from './zip.js';
import { mimeOf, isImageName } from './util.js';

export function resolvePath(base, href) {
  const u = new URL(href, 'http://e/' + base);
  return decodeURIComponent(u.pathname.slice(1));
}

export function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
}

export function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length && type !== 'text/html') {
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

export function byTag(doc, tag) {
  const list = doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS('*', tag) : [];
  return list.length ? Array.from(list) : Array.from(doc.getElementsByTagName(tag));
}

// ZIP エントリから EPUB のパッケージ情報（目次・並び順など）を読む
export async function openPackage(entries) {
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
  const opfDir = dirOf(opfPath);
  const opf = parseXml(await text(opfPath));

  const manifest = new Map();
  for (const item of byTag(opf, 'item')) {
    manifest.set(item.getAttribute('id'), {
      id: item.getAttribute('id'),
      path: resolvePath(opfDir, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    });
  }

  let prePaginated = false;
  let coverId = null;
  for (const m of byTag(opf, 'meta')) {
    if (m.getAttribute('property') === 'rendition:layout' && m.textContent.trim() === 'pre-paginated') prePaginated = true;
    if (m.getAttribute('name') === 'cover') coverId = m.getAttribute('content');
  }

  const spineEl = byTag(opf, 'spine')[0];
  const ppd = spineEl && spineEl.getAttribute('page-progression-direction');
  const spine = [];
  for (const ref of spineEl ? byTag(spineEl, 'itemref') : []) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !map.has(item.path)) continue;
    if (ref.getAttribute('linear') === 'no') continue;
    const props = ref.getAttribute('properties') || '';
    spine.push({
      ...item,
      fixed: props.includes('rendition:layout-pre-paginated') || (prePaginated && !props.includes('rendition:layout-reflowable')),
      size: map.get(item.path).size || 0,
    });
  }

  const titleEl = byTag(opf, 'title')[0];
  let cover = [...manifest.values()].find((i) => i.props.split(/\s+/).includes('cover-image'));
  if (!cover && coverId) cover = manifest.get(coverId);

  return {
    map, text, opfDir, manifest, spine, prePaginated,
    title: titleEl ? titleEl.textContent.trim() : '',
    direction: ppd === 'rtl' ? 'rtl' : ppd === 'ltr' ? 'ltr' : null,
    tocId: spineEl && spineEl.getAttribute('toc'),
    coverPath: cover && map.has(cover.path) && isImageName(cover.path) ? cover.path : null,
  };
}

// XHTML 内の画像パスを列挙
export function imagesIn(doc, dir) {
  const out = [];
  for (const img of byTag(doc, 'img')) {
    const src = img.getAttribute('src');
    if (src) out.push(resolvePath(dir, src));
  }
  for (const im of byTag(doc, 'image')) {
    const href = im.getAttribute('xlink:href') || im.getAttribute('href') ||
      im.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (href) out.push(resolvePath(dir, href));
  }
  return out;
}

export function textLength(doc) {
  const body = doc.body || byTag(doc, 'body')[0];
  return body ? body.textContent.replace(/\s+/g, '').length : 0;
}

export async function readEpub(file) {
  const pkg = await openPackage(await readZip(file));
  const { map, spine } = pkg;

  const imagePaths = [];
  const seen = new Set();
  let textSections = 0;
  let firstImage = null;
  const add = (path) => {
    if (!map.has(path) || !isImageName(path)) return;
    if (!firstImage) firstImage = path;
    if (!seen.has(path)) { seen.add(path); imagePaths.push(path); }
  };

  for (const item of spine) {
    if (item.type.startsWith('image/')) { add(item.path); continue; }
    if (!/html|xml|svg/.test(item.type)) continue;
    let doc;
    try { doc = parseXml(await pkg.text(item.path), 'application/xhtml+xml'); } catch { continue; }
    if (textLength(doc) > 0 && !item.props.includes('nav')) textSections++;
    for (const p of imagesIn(doc, dirOf(item.path))) add(p);
  }

  // 固定レイアウトの漫画に奥付などの文字ページが少しだけある場合は画像モードのまま
  const textMode = textSections > 0 && !(pkg.prePaginated && textSections <= spine.length * 0.1 && imagePaths.length);
  if (!textMode && !imagePaths.length) {
    throw new Error('表示できるページが見つかりません（DRM 付きの EPUB には対応していません）');
  }

  const coverPath = pkg.coverPath || firstImage;
  return {
    title: pkg.title,
    direction: pkg.direction,
    textMode,
    sectionSizes: spine.map((s) => s.size),
    getCover: coverPath ? () => map.get(coverPath).getBlob(mimeOf(coverPath)) : null,
    pages: imagePaths.map((p) => ({ name: p, getBlob: () => map.get(p).getBlob(mimeOf(p)) })),
  };
}
