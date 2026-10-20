// 文章を含む EPUB（小説など）を画面サイズのページに分けて表示する
//
// しくみ:
//   - 章（spine の各ファイル）を iframe に読み込み、CSS の段組み（column）で画面幅ごとのページに分割する
//   - 縦書き（vertical-rl）の本は段が下方向に並ぶので、縦方向にずらしてページを切り替える
//   - ページ送りは iframe の位置をずらすだけなので速い。前後の章も裏で読み込んでおく
//   - 挿絵だけの章は画面いっぱいに表示、固定レイアウトの章は縮小して1ページで表示
import { readZip } from './zip.js';
import { openPackage, resolvePath, dirOf, parseXml, byTag, imagesIn, textLength } from './epub.js';
import { mimeOf, escapeHtml } from './util.js';

const XLINK = 'http://www.w3.org/1999/xlink';
const XHTML = 'http://www.w3.org/1999/xhtml';
const isAbs = (u) => /^(data:|blob:|https?:|mailto:|#)/i.test(u);

const EXTRA_TYPES = {
  css: 'text/css', svg: 'image/svg+xml', otf: 'font/otf', ttf: 'font/ttf',
  woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4',
};

export class EpubView {
  constructor(host) {
    this.host = host;
    this.frames = new Map(); // 章番号 -> { iframe, pages, kind, vertical, ready }
    this.res = new Map();    // パス -> Promise<blob URL>
    this.docs = new Map();   // 章番号 -> Promise<{ kind, url, fixed }>
    this.cur = null;
    this.page = 0;
    this.opts = { double: false, dark: false, fontSize: 18 };
  }

  // 1冊ごとに新しいインスタンスを使う（閉じた後に届いた非同期処理は無視する）
  async open(blob, opts) {
    this.opts = { ...opts };
    const pkg = await openPackage(await readZip(blob));
    if (this.closed) return;
    this.pkg = pkg;
    this.sections = this.pkg.spine;
    if (!this.sections.length) throw new Error('表示できるページがありません');
    this.weights = this.sections.map((s) => Math.max(2000, s.size));
    this.cum = [];
    let t = 0;
    for (const w of this.weights) { this.cum.push(t); t += w; }
    this.total = t;
    this.types = new Map([...this.pkg.manifest.values()].map((i) => [i.path, i.type]));
  }

  close() {
    this.closed = true;
    for (const f of this.frames.values()) f.iframe.remove();
    this.frames.clear();
    for (const p of this.res.values()) p.then((u) => u && URL.revokeObjectURL(u));
    this.res.clear();
    for (const p of this.docs.values()) p.then((d) => d && URL.revokeObjectURL(d.url)).catch(() => {});
    this.docs.clear();
    this.cur = null;
    this.tocCache = null;
  }

  // ---------- リソース ----------

  typeOf(path) {
    const ext = (/\.([^./]+)$/.exec(path) || [])[1]?.toLowerCase() || '';
    return this.types.get(path) || mimeOf(path) || EXTRA_TYPES[ext] || '';
  }

  resource(path) {
    if (!this.res.has(path)) {
      this.res.set(path, (async () => {
        const e = this.pkg.map.get(path);
        if (!e) return null;
        const type = this.typeOf(path);
        if (type === 'text/css') {
          const css = await this.rewriteCss(await (await e.getBlob()).text(), dirOf(path));
          return URL.createObjectURL(new Blob([css], { type: 'text/css' }));
        }
        return URL.createObjectURL(await e.getBlob(type));
      })().catch(() => null));
    }
    return this.res.get(path);
  }

  async rewriteCss(css, dir) {
    css = css
      .replace(/-epub-text-combine(-horizontal)?\s*:\s*horizontal/g, 'text-combine-upright: all')
      .replace(/-epub-text-emphasis/g, '-webkit-text-emphasis')
      .replace(/-epub-(?=[a-z])/g, '');
    const urls = new Set();
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    for (const m of css.matchAll(re)) if (!isAbs(m[2])) urls.add(m[2]);
    for (const m of css.matchAll(/@import\s+(['"])([^'"]+)\1/g)) if (!isAbs(m[2])) urls.add(m[2]);
    const map = new Map();
    for (const u of urls) map.set(u, await this.resource(resolvePath(dir, u)));
    return css
      .replace(re, (m, q, u) => (map.get(u) ? `url("${map.get(u)}")` : m))
      .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => (map.get(u) ? `@import url("${map.get(u)}")` : m));
  }

  // ---------- 章の HTML を作る ----------

  build(i) {
    if (!this.docs.has(i)) this.docs.set(i, this.buildSection(i));
    return this.docs.get(i);
  }

  async buildSection(i) {
    const sec = this.sections[i];
    const imageDoc = (src) => ({
      kind: 'image',
      url: URL.createObjectURL(new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"><style id="mv-style"></style><style>html,body{margin:0;height:100%;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img src="${escapeHtml(src || '')}" alt=""></body></html>`], { type: 'text/html;charset=utf-8' })),
    });
    if (sec.type.startsWith('image/')) return imageDoc(await this.resource(sec.path));

    const raw = await this.pkg.text(sec.path);
    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    let xml = true;
    if (doc.getElementsByTagName('parsererror').length) {
      doc = new DOMParser().parseFromString(raw, 'text/html');
      xml = false;
    }
    const dir = dirOf(sec.path);

    // 挿絵だけのページ
    const imgs = imagesIn(doc, dir);
    if (textLength(doc) === 0 && imgs.length === 1) return imageDoc(await this.resource(imgs[0]));

    // 固定レイアウト
    let fixed = null;
    const vp = byTag(doc, 'meta').find((m) => (m.getAttribute('name') || '').toLowerCase() === 'viewport');
    if (sec.fixed && vp) {
      const c = vp.getAttribute('content') || '';
      const w = /width\s*=\s*(\d+)/.exec(c), h = /height\s*=\s*(\d+)/.exec(c);
      if (w && h) fixed = { w: Number(w[1]), h: Number(h[1]) };
    }

    for (const s of byTag(doc, 'script')) s.remove();
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      const tag = el.localName.toLowerCase();
      if (tag === 'a') { el.removeAttribute('href'); continue; }
      if (tag === 'link') {
        const href = el.getAttribute('href');
        if (href && /stylesheet/i.test(el.getAttribute('rel') || '') && !isAbs(href)) {
          const u = await this.resource(resolvePath(dir, href));
          if (u) el.setAttribute('href', u); else el.remove();
        }
        continue;
      }
      if (tag === 'style') { el.textContent = await this.rewriteCss(el.textContent, dir); continue; }
      el.removeAttribute('srcset');
      for (const attr of ['src', 'poster']) {
        const v = el.getAttribute(attr);
        if (v && !isAbs(v)) {
          const u = await this.resource(resolvePath(dir, v));
          if (u) el.setAttribute(attr, u);
        }
      }
      if (tag === 'image' || tag === 'use') {
        const v = el.getAttributeNS(XLINK, 'href') || el.getAttribute('href');
        if (v && !isAbs(v)) {
          const u = await this.resource(resolvePath(dir, v));
          if (u) {
            el.setAttributeNS(XLINK, 'xlink:href', u);
            if (el.hasAttribute('href')) el.setAttribute('href', u);
          }
        }
      }
      const st = el.getAttribute('style');
      if (st && /url\(|-epub-/.test(st)) el.setAttribute('style', await this.rewriteCss(st, dir));
    }

    // 表示用のスタイルを差し込む場所
    const head = doc.head || byTag(doc, 'head')[0] || doc.documentElement;
    const mv = doc.createElementNS(XHTML, 'style');
    mv.setAttribute('id', 'mv-style');
    head.appendChild(mv);

    const out = xml
      ? new XMLSerializer().serializeToString(doc)
      : '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    const type = xml ? 'application/xhtml+xml' : 'text/html;charset=utf-8';
    return { kind: fixed ? 'fixed' : 'flow', fixed, url: URL.createObjectURL(new Blob([out], { type })) };
  }

  // ---------- iframe ----------

  frame(i) {
    if (this.closed) throw new Error('closed');
    let f = this.frames.get(i);
    if (f) return f;
    const iframe = document.createElement('iframe');
    iframe.className = 'epub-frame';
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('scrolling', 'no');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.visibility = 'hidden';
    iframe.style.width = this.host.clientWidth + 'px';
    iframe.style.height = this.host.clientHeight + 'px';
    this.host.appendChild(iframe);
    f = { section: i, iframe, pages: 1, kind: 'flow', vertical: false, loaded: false };
    f.ready = (async () => {
      const b = await this.build(i);
      f.kind = b.kind;
      f.fixed = b.fixed;
      await new Promise((resolve) => {
        iframe.onload = resolve;
        iframe.onerror = resolve;
        iframe.src = b.url;
      });
      try { await iframe.contentDocument.fonts.ready; } catch { /* ignore */ }
      if (this.closed) { iframe.remove(); return; }
      f.loaded = true;
      this.paginate(f);
    })();
    this.frames.set(i, f);
    return f;
  }

  paginate(f) {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const s = f.iframe.style;
    s.transform = '';
    s.width = W + 'px';
    s.height = H + 'px';
    const doc = f.iframe.contentDocument;
    if (!doc || !doc.documentElement) { f.pages = 1; return; }
    const html = doc.documentElement;
    let st = doc.getElementById('mv-style');
    if (!st) {
      st = doc.createElementNS(XHTML, 'style');
      (doc.head || html).appendChild(st);
    }
    const { dark, fontSize, double } = this.opts;
    const fg = dark ? '#d6d6d6' : '#1d1d1f';
    const bg = dark ? '#000' : '#fff';

    if (f.kind === 'image') {
      st.textContent = `html,body{background:${bg}!important}`;
      f.pages = 1;
      return;
    }
    if (f.kind === 'fixed') {
      const { w, h } = f.fixed;
      const sc = Math.min(W / w, H / h);
      s.width = w + 'px';
      s.height = h + 'px';
      s.transform = `translate(${(W - w * sc) / 2}px, ${(H - h * sc) / 2}px) scale(${sc})`;
      f.pages = 1;
      return;
    }

    // 文字色・背景・文字サイズ（段組みの前に適用して縦書きかどうかを判定）
    const colors = dark
      ? `html{color:${fg}!important;background:${bg}!important}body,body *{color:inherit!important;background-color:transparent!important}`
      : `html{color:${fg};background:${bg}!important}`;
    st.textContent = `${colors}html{font-size:${fontSize}px!important;-webkit-text-size-adjust:none!important;text-size-adjust:none!important}body{margin:0!important;padding:0!important}`;
    const win = f.iframe.contentWindow;
    const wm = win.getComputedStyle(doc.body || html).writingMode + ' ' + win.getComputedStyle(html).writingMode;
    f.vertical = /vertical|tb-rl|tb-lr/.test(wm); // horizontal-tb は横書き

    const gap = Math.round(Math.max(32, Math.min(W, H) * 0.07));
    const pad = Math.round(gap * 0.8);
    let css;
    if (!f.vertical) {
      // 横書き：横方向に段を並べる（2ページ表示なら1画面に2段）
      const n = double && W >= 700 ? 2 : 1;
      const colW = W / n - gap, colH = H - pad * 2;
      css = `html{width:${W}px!important;height:${H}px!important;max-width:none!important;max-height:none!important;margin:0!important;padding:${pad}px ${gap / 2}px!important;box-sizing:border-box!important;column-count:${n}!important;column-width:auto!important;column-gap:${gap}px!important;column-fill:auto!important;overflow:visible!important}`
        + `img,svg,video{max-width:${colW}px!important;max-height:${colH}px!important;object-fit:contain}img{height:auto}`;
    } else {
      // 縦書き：段は下方向に並ぶ
      const colW = W - pad * 2, colH = H - gap;
      css = `html{writing-mode:vertical-rl!important;-webkit-writing-mode:vertical-rl!important;width:${W}px!important;height:${H}px!important;max-width:none!important;max-height:none!important;margin:0!important;padding:${gap / 2}px ${pad}px!important;box-sizing:border-box!important;column-count:1!important;column-width:auto!important;column-gap:${gap}px!important;column-fill:auto!important;overflow:visible!important}`
        + `img,svg,video{max-width:${colW}px!important;max-height:${colH}px!important;object-fit:contain}img{width:auto}`;
    }
    st.textContent += css;

    if (!f.vertical) {
      f.pages = Math.max(1, Math.round(html.scrollWidth / W));
      s.width = f.pages * W + 'px';
    } else {
      f.pages = Math.max(1, Math.round(html.scrollHeight / H));
      s.height = f.pages * H + 'px';
    }
  }

  place(f, page) {
    if (f.kind !== 'flow') return;
    const W = this.host.clientWidth, H = this.host.clientHeight;
    f.iframe.style.transform = f.vertical ? `translateY(${-page * H}px)` : `translateX(${-page * W}px)`;
  }

  // ---------- 移動 ----------

  async show(i, at = 0) {
    i = Math.max(0, Math.min(this.sections.length - 1, i));
    const f = this.frame(i);
    await f.ready;
    if (this.closed) return;
    let p =at === 'last' ? f.pages - 1 : typeof at === 'object' ? Math.floor((at.fraction || 0) * f.pages) : at;
    p = Math.max(0, Math.min(f.pages - 1, p));
    this.cur = f;
    this.page = p;
    this.place(f, p);
    for (const x of this.frames.values()) x.iframe.style.visibility = x === f ? 'visible' : 'hidden';
    // 前後の章だけ残し、さらに先読み
    for (const [k, x] of this.frames) {
      if (Math.abs(k - i) > 1) { x.iframe.remove(); this.frames.delete(k); }
    }
    if (i + 1 < this.sections.length) this.frame(i + 1);
    if (i > 0) this.frame(i - 1);
  }

  async next() {
    const f = this.cur;
    if (!f) return false;
    if (this.page < f.pages - 1) { this.page++; this.place(f, this.page); return true; }
    if (f.section < this.sections.length - 1) { await this.show(f.section + 1, 0); return true; }
    return false;
  }

  async prev() {
    const f = this.cur;
    if (!f) return false;
    if (this.page > 0) { this.page--; this.place(f, this.page); return true; }
    if (f.section > 0) { await this.show(f.section - 1, 'last'); return true; }
    return false;
  }

  async relayout(opts) {
    this.opts = { ...opts };
    if (!this.cur) return;
    const frac = this.page / this.cur.pages;
    for (const f of this.frames.values()) if (f.loaded) this.paginate(f);
    await this.show(this.cur.section, { fraction: frac + 1e-6 });
  }

  location() {
    const f = this.cur;
    if (!f) return { section: 0, page: 0, pages: 1, fraction: 0, percent: 0 };
    const s = f.section;
    return {
      section: s,
      page: this.page,
      pages: f.pages,
      fraction: this.page / f.pages,
      percent: (this.cum[s] + ((this.page + 1) / f.pages) * this.weights[s]) / this.total,
    };
  }

  async goToPercent(p) {
    const x = Math.max(0, Math.min(1, p)) * this.total;
    let s = this.cum.findIndex((c, k) => x < c + this.weights[k]);
    if (s < 0) s = this.sections.length - 1;
    await this.show(s, { fraction: (x - this.cum[s]) / this.weights[s] });
  }

  // ---------- 目次 ----------

  async toc() {
    if (this.tocCache) return this.tocCache;
    const pkg = this.pkg;
    const items = [];
    try {
      const nav = [...pkg.manifest.values()].find((i) => i.props.split(/\s+/).includes('nav'));
      if (nav) {
        const doc = parseXml(await pkg.text(nav.path), 'application/xhtml+xml');
        const navs = byTag(doc, 'nav');
        const el = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
        for (const a of el ? byTag(el, 'a') : []) {
          const href = a.getAttribute('href');
          if (href) items.push({ label: a.textContent.trim(), path: resolvePath(dirOf(nav.path), href.split('#')[0]) });
        }
      } else if (pkg.tocId && pkg.manifest.get(pkg.tocId)) {
        const ncx = pkg.manifest.get(pkg.tocId);
        const doc = parseXml(await pkg.text(ncx.path));
        for (const np of byTag(doc, 'navPoint')) {
          const label = byTag(np, 'text')[0];
          const src = byTag(np, 'content')[0];
          if (src && src.getAttribute('src')) {
            items.push({ label: label ? label.textContent.trim() : '', path: resolvePath(dirOf(ncx.path), src.getAttribute('src').split('#')[0]) });
          }
        }
      }
    } catch { /* 目次なし */ }
    this.tocCache = items
      .map((x) => ({ label: x.label || '（無題）', section: this.sections.findIndex((s) => s.path === x.path) }))
      .filter((x) => x.section >= 0);
    return this.tocCache;
  }
}
