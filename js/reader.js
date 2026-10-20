// 漫画リーダー本体
// 高速化のポイント:
//   - 前後のページを先読みし、img.decode() でデコード済みの <img> を保持しておく
//   - ページをめくるときは保持している <img> を差し替えるだけ（アニメーションなし）
//   - 巻の終わりでは次の巻の最初のページも先読みしておく
import * as db from './db.js';
import { settings, setSetting } from './settings.js';
import { naturalCompare, escapeHtml } from './util.js';
import { EpubView } from './epubview.js';

const TEXT_SIZES = { S: 15, M: 18, L: 21, XL: 25 };

const MAX_ZOOM = 4;

export class Reader {
  constructor({ onExit, onOpenSettings, onVolumeChange, toast, showSheet }) {
    this.onExit = onExit;
    this.showSheet = showSheet;
    this.onVolumeChange = onVolumeChange;
    this.onOpenSettings = onOpenSettings;
    this.toast = toast;

    this.el = document.getElementById('reader');
    this.stage = document.getElementById('stage');
    this.spreadEl = document.getElementById('spread');
    this.pageNumEl = document.getElementById('page-num');
    this.ui = document.getElementById('reader-ui');
    this.titleEl = document.getElementById('r-title');
    this.slider = document.getElementById('r-slider');
    this.posEl = document.getElementById('r-pos');
    this.modeBtn = document.getElementById('r-mode');
    this.dirBtn = document.getElementById('r-dir');
    this.shiftBtn = document.getElementById('r-shift');
    this.prevVolBtn = document.getElementById('r-prevvol');
    this.nextVolBtn = document.getElementById('r-nextvol');
    this.tocBtn = document.getElementById('r-toc');
    this.textHost = document.getElementById('textview');

    this.cache = new Map();   // "volumeId:index" -> { promise, img, url, dead }
    this.handoff = new Set(); // 次／前の巻の先読みキー
    this.token = 0;
    this.active = false;
    this.zoom = { s: 1, tx: 0, ty: 0 };
    this.pointers = new Map();
    this.gesture = null;
    this.saveTimer = null;
    this.cardUrl = null;
    this.mode = 'image';      // image（画像の巻）| text（文章を含む EPUB）
    this.text = null;         // EpubView
    this.textQueue = Promise.resolve();

    this.bindUI();
    this.bindGestures();
  }

  // ---------- 開く／閉じる ----------

  async open(volumeId, at = 'resume') {
    const vol = await db.get('volumes', volumeId);
    if (!vol) throw new Error('巻が見つかりません');
    const series = await db.get('series', vol.seriesId);
    const vols = await db.getAllByIndex('volumes', 'seriesId', vol.seriesId);
    vols.sort((a, b) => naturalCompare(a.title, b.title));

    this.flushSave();
    this.vol = vol;
    this.series = series;
    this.vols = vols;
    this.volIndex = vols.findIndex((v) => v.id === vol.id);
    this.progress = await db.get('progress', vol.id);
    this.active = true;
    this.handoff.clear();
    if (this.onVolumeChange) this.onVolumeChange(vol.id);

    if (vol.kind === 'epub') { await this.openText(vol, at); return; }
    this.mode = 'image';
    if (this.text) this.text.close();
    this.textHost.style.visibility = 'hidden';

    let page = 0;
    if (at === 'end') page = vol.pageCount - 1;
    else if (typeof at === 'number') page = at;
    else if (at === 'resume' && this.progress && !this.progress.finished) page = this.progress.page;
    page = Math.max(0, Math.min(page, vol.pageCount - 1));

    this.layout();
    this.pos = this.spreadOf(page);
    this.resetZoom();
    this.render();
    this.scheduleSave(0);
  }

  // 文章を含む EPUB を開く
  async openText(vol, at) {
    this.mode = 'text';
    this.token++;
    this.layout();
    this.pos = 0;
    this.resetZoom();
    this.spreadEl.className = 'one';
    this.spreadEl.innerHTML = '<div class="loading">読み込み中…</div>';
    if (this.text) this.text.close();
    const text = this.text = new EpubView(this.textHost);
    this.textHost.style.visibility = 'visible';
    const blob = await db.getPage(vol.id, 0);
    if (!blob) throw new Error('EPUB のデータが見つかりません');
    await text.open(blob, this.textOpts());
    if (text !== this.text) return; // 読み込み中に別の巻が開かれた

    let section = 0, where = 0;
    if (at === 'end') { section = this.text.sections.length - 1; where = 'last'; }
    else if (typeof at === 'number') section = at;
    else if (at === 'resume' && this.progress && !this.progress.finished) {
      section = this.progress.page;
      where = { fraction: (this.progress.offset || 0) + 1e-6 };
    }
    await text.show(section, where);
    if (text !== this.text) return;
    this.render();
    this.scheduleSave(0);
  }

  textOpts() {
    return {
      double: this.isDouble(),
      dark: document.documentElement.dataset.theme === 'dark',
      fontSize: TEXT_SIZES[settings.textSize] || TEXT_SIZES.M,
    };
  }

  // テキストモードの操作は順番に処理する（連打しても飛ばない）
  queueText(fn) {
    this.textQueue = this.textQueue.then(fn).catch((e) => console.error(e));
    return this.textQueue;
  }

  textMoved() {
    this.resetZoom();
    this.updateUI();
    this.scheduleSave();
  }

  close() {
    this.flushSave();
    this.active = false;
    if (this.text) this.text.close();
    this.textHost.style.visibility = 'hidden';
    this.token++;
    this.hideUI();
    this.spreadEl.replaceChildren();
    for (const [key] of this.cache) this.evict(key);
    this.handoff.clear();
  }

  // ---------- レイアウト ----------

  get direction() {
    const d = this.series && this.series.direction;
    return d === 'rtl' || d === 'ltr' ? d : settings.direction;
  }

  isDouble() {
    return settings.pageMode === 'double' || (settings.pageMode === 'auto' && window.innerWidth > window.innerHeight);
  }

  layout() {
    if (this.mode === 'text') {
      this.double = this.isDouble();
      this.spreads = [[0]];
      return;
    }
    const n = this.vol.pageCount;
    const dims = this.vol.dims || [];
    const wide = (i) => settings.wideSingle && dims[i] && dims[i][0] > dims[i][1] * 1.1;
    const spreads = [];
    this.double = this.isDouble();
    if (!this.double) {
      for (let i = 0; i < n; i++) spreads.push([i]);
    } else {
      let i = 0;
      let cover = settings.coverSingle;
      if (this.vol.shift) cover = !cover;
      if (cover && n > 0) { spreads.push([0]); i = 1; }
      while (i < n) {
        if (wide(i)) { spreads.push([i]); i++; continue; }
        if (i + 1 < n && !wide(i + 1)) { spreads.push([i, i + 1]); i += 2; }
        else { spreads.push([i]); i++; }
      }
    }
    this.spreads = spreads;
  }

  spreadOf(page) {
    const i = this.spreads.findIndex((sp) => sp.includes(page));
    return i < 0 ? 0 : i;
  }

  currentPage() {
    if (this.mode === 'text') return this.text && this.text.cur ? this.text.cur.section : 0;
    if (this.pos < 0) return 0;
    if (this.pos >= this.spreads.length) return this.vol.pageCount - 1;
    return this.spreads[this.pos][0];
  }

  relayout() {
    if (!this.active) return;
    if (this.mode === 'text') {
      this.double = this.isDouble();
      this.queueText(async () => { await this.text.relayout(this.textOpts()); this.updateUI(); });
      return;
    }
    const atEnd = this.pos >= this.spreads.length;
    const atStart = this.pos < 0;
    const page = this.currentPage();
    this.layout();
    this.pos = atEnd ? this.spreads.length : atStart ? -1 : this.spreadOf(page);
    this.resetZoom();
    this.render();
  }

  // ---------- 画像キャッシュ ----------

  load(vid, i) {
    const key = vid + ':' + i;
    let e = this.cache.get(key);
    if (e) return e.promise;
    e = { img: null, url: null, dead: false };
    e.promise = (async () => {
      const blob = await db.getPage(vid, i);
      if (!blob || e.dead) return null;
      e.url = URL.createObjectURL(blob);
      const img = new Image();
      img.draggable = false;
      img.alt = '';
      img.src = e.url;
      // デコードが止まっても表示を待たせ続けない（バックグラウンド時など）
      await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      if (e.dead) { URL.revokeObjectURL(e.url); return null; }
      e.img = img;
      return img;
    })();
    this.cache.set(key, e);
    return e.promise;
  }

  evict(key) {
    const e = this.cache.get(key);
    if (!e) return;
    e.dead = true;
    if (e.url) URL.revokeObjectURL(e.url);
    this.cache.delete(key);
  }

  prefetch(token) {
    const vid = this.vol.id;
    const want = [];
    const push = (sp) => sp && sp.forEach((i) => want.push(i));
    for (let d = 0; d <= settings.preload; d++) push(this.spreads[this.pos + d]);
    for (let d = 1; d <= 2; d++) push(this.spreads[this.pos - d]);

    const keep = new Set(want.map((i) => vid + ':' + i));
    // 巻の終わり／始まりでは隣の巻も先読み
    const nextVol = this.vols[this.volIndex + 1];
    const prevVol = this.vols[this.volIndex - 1];
    const extra = [];
    if (nextVol && nextVol.kind !== 'epub' && this.pos >= this.spreads.length - 1) {
      for (let i = 0; i < Math.min(2, nextVol.pageCount); i++) extra.push([nextVol.id, i]);
    }
    if (prevVol && prevVol.kind !== 'epub' && this.pos < 0) {
      for (let i = Math.max(0, prevVol.pageCount - 2); i < prevVol.pageCount; i++) extra.push([prevVol.id, i]);
    }
    for (const [v, i] of extra) { const k = v + ':' + i; keep.add(k); this.handoff.add(k); }

    for (const key of [...this.cache.keys()]) {
      if (!keep.has(key) && !(this.handoff.has(key) && !key.startsWith(vid + ':'))) this.evict(key);
    }
    (async () => {
      for (const i of want) {
        if (token !== this.token) return;
        await this.load(vid, i);
      }
      for (const [v, i] of extra) {
        if (token !== this.token) return;
        await this.load(v, i);
      }
    })();
  }

  // ---------- 描画 ----------

  async render() {
    const token = ++this.token;
    this.updateUI();
    if (this.mode === 'text') {
      const onText = this.pos === 0;
      this.textHost.style.visibility = onText ? 'visible' : 'hidden';
      if (onText) { this.spreadEl.replaceChildren(); this.clearCardUrl(); }
      else this.renderCard(this.pos < 0 ? 'start' : 'end');
      return;
    }
    if (this.pos < 0 || this.pos >= this.spreads.length) {
      this.renderCard(this.pos < 0 ? 'start' : 'end');
      this.prefetch(token);
      return;
    }
    const pages = this.spreads[this.pos];
    const imgs = await Promise.all(pages.map((i) => this.load(this.vol.id, i)));
    if (token !== this.token) return;

    const slots = pages.map((p, k) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      if (imgs[k]) slot.appendChild(imgs[k]);
      else slot.innerHTML = '<div class="missing">ページを読み込めませんでした</div>';
      return slot;
    });
    if (slots.length === 2) {
      // 右開き: 若いページが右側
      if (this.direction === 'rtl') slots.reverse();
      slots[0].classList.add('left');
      slots[1].classList.add('right');
    }
    this.spreadEl.className = slots.length === 2 ? 'two' : 'one';
    this.spreadEl.replaceChildren(...slots);
    this.clearCardUrl();
    this.prefetch(token);
  }

  clearCardUrl() {
    if (this.cardUrl) { URL.revokeObjectURL(this.cardUrl); this.cardUrl = null; }
  }

  renderCard(type) {
    const isEnd = type === 'end';
    const target = this.vols[this.volIndex + (isEnd ? 1 : -1)];
    this.clearCardUrl();
    let thumb = '';
    if (target && target.thumb) {
      this.cardUrl = URL.createObjectURL(target.thumb);
      thumb = `<img class="card-thumb" src="${this.cardUrl}" alt="">`;
    }
    const label = isEnd ? '次の巻' : '前の巻';
    const card = document.createElement('div');
    card.className = 'end-card';
    card.innerHTML = `
      <div class="card-head">${isEnd ? '読了' : '最初のページです'}</div>
      <div class="card-sub">${escapeHtml(this.series.title)} ${escapeHtml(this.vol.title)}</div>
      ${target ? `
        ${thumb}
        <div class="card-next">${label}：${escapeHtml(target.title)}</div>
        <div class="card-hint">もう一度「${isEnd ? '次へ' : '前へ'}」をタップすると${label}を開きます</div>
      ` : `
        <div class="card-next">${isEnd ? 'これが最後の巻です' : ''}</div>
        <div class="card-hint">${isEnd ? 'もう一度「次へ」をタップすると本棚に戻ります' : ''}</div>
      `}`;
    this.spreadEl.className = 'one';
    this.spreadEl.replaceChildren(card);
    if (isEnd) this.scheduleSave(0);
  }

  // ---------- ページ移動 ----------

  next() {
    if (this.mode === 'text' && this.pos === 0) {
      this.queueText(async () => {
        if (this.pos !== 0) return;
        if (await this.text.next()) this.textMoved();
        else { this.pos = 1; this.moved(); }
      });
      return;
    }
    if (this.pos < this.spreads.length) { this.pos++; this.moved(); return; }
    const nv = this.vols[this.volIndex + 1];
    if (nv) this.open(nv.id, 'resume').catch((e) => this.toast(e.message));
    else this.onExit();
  }

  prev() {
    const pv = this.vols[this.volIndex - 1];
    if (this.mode === 'text' && this.pos === 0) {
      this.queueText(async () => {
        if (this.pos !== 0) return;
        if (await this.text.prev()) this.textMoved();
        else if (pv) { this.pos = -1; this.moved(); }
        else this.toast('最初のページです');
      });
      return;
    }
    if (this.pos > 0) { this.pos--; this.moved(); return; }
    if (this.pos === 0) {
      if (pv) { this.pos = -1; this.moved(); }
      else this.toast('最初のページです');
      return;
    }
    if (pv) this.open(pv.id, 'end').catch((e) => this.toast(e.message));
  }

  goToSpread(i) {
    i = Math.max(0, Math.min(this.spreads.length - 1, i));
    if (i === this.pos) return;
    this.pos = i;
    this.moved();
  }

  moved() {
    this.resetZoom();
    this.render();
    this.scheduleSave();
  }

  // ---------- 進捗の保存 ----------

  scheduleSave(delay = 400) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), delay);
  }

  flushSave() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.save(); }
  }

  save() {
    this.saveTimer = null;
    if (!this.vol) return;
    const finished = this.pos >= this.spreads.length;
    const rec = {
      volumeId: this.vol.id,
      seriesId: this.vol.seriesId,
      page: this.currentPage(),
      total: this.vol.pageCount,
      finished,
      completed: finished || !!(this.progress && this.progress.completed),
      updatedAt: Date.now(),
    };
    if (this.mode === 'text' && this.text && this.text.cur) {
      const loc = this.text.location();
      rec.offset = loc.fraction;
      rec.percent = finished ? 1 : loc.percent;
    }
    this.progress = rec;
    db.put('progress', rec).catch(() => {});
  }

  // ---------- UI ----------

  bindUI() {
    document.getElementById('r-back').addEventListener('click', () => this.onExit());
    document.getElementById('r-settings').addEventListener('click', () => this.onOpenSettings());
    this.modeBtn.addEventListener('click', () => {
      const order = ['auto', 'single', 'double'];
      setSetting('pageMode', order[(order.indexOf(settings.pageMode) + 1) % order.length]);
      this.relayout();
    });
    this.dirBtn.addEventListener('click', async () => {
      this.series.direction = this.direction === 'rtl' ? 'ltr' : 'rtl';
      await db.put('series', this.series);
      this.render();
    });
    this.shiftBtn.addEventListener('click', async () => {
      this.vol.shift = !this.vol.shift;
      await db.put('volumes', this.vol);
      this.relayout();
    });
    this.prevVolBtn.addEventListener('click', () => {
      const pv = this.vols[this.volIndex - 1];
      if (pv) this.open(pv.id, 'resume');
    });
    this.nextVolBtn.addEventListener('click', () => {
      const nv = this.vols[this.volIndex + 1];
      if (nv) this.open(nv.id, 'resume');
    });
    this.slider.addEventListener('input', () => {
      const v = Number(this.slider.value);
      if (this.mode !== 'text') { this.goToSpread(v); return; }
      // スライダーを動かしている間は最後の位置だけ反映する
      this.sliderTarget = v / 1000;
      if (this.sliderBusy) return;
      this.sliderBusy = true;
      this.queueText(async () => {
        this.pos = 0;
        while (this.sliderTarget != null) {
          const t = this.sliderTarget;
          this.sliderTarget = null;
          await this.text.goToPercent(t);
        }
        this.sliderBusy = false;
        this.render();
        this.textMoved();
      });
    });
    this.tocBtn.addEventListener('click', async () => {
      if (this.mode !== 'text') return;
      const toc = await this.text.toc();
      if (!toc.length) { this.toast('目次がありません'); return; }
      this.showSheet('目次', toc.map((t) => ({
        label: t.label,
        fn: () => {
          this.hideUI();
          this.queueText(async () => {
            await this.text.show(t.section, 0);
            this.pos = 0;
            this.render();
            this.textMoved();
          });
        },
      })));
    });
  }

  updateUI() {
    if (!this.vol) return;
    const n = this.vol.pageCount;
    this.titleEl.textContent = `${this.series.title}　${this.vol.title}`;
    const isText = this.mode === 'text';
    this.tocBtn.hidden = !isText;
    this.modeBtn.textContent = { auto: '表示：自動', single: '表示：1ページ', double: '表示：2ページ' }[settings.pageMode];
    this.dirBtn.textContent = this.direction === 'rtl' ? '右開き' : '左開き';
    this.prevVolBtn.disabled = !this.vols[this.volIndex - 1];
    this.nextVolBtn.disabled = !this.vols[this.volIndex + 1];
    this.pageNumEl.hidden = !settings.showPageNum;
    if (isText) {
      const pct = this.pos > 0 ? 1 : this.pos < 0 ? 0 : this.text.location().percent;
      this.slider.max = '1000';
      this.slider.value = String(Math.round(pct * 1000));
      this.slider.classList.toggle('rtl', this.direction === 'rtl');
      const label = this.pos < 0 ? '始まり' : this.pos > 0 ? '読了' : `${Math.round(pct * 100)}%`;
      this.posEl.textContent = label;
      this.pageNumEl.textContent = label;
      this.shiftBtn.hidden = true;
      return;
    }
    this.slider.max = String(Math.max(0, this.spreads.length - 1));
    this.slider.value = String(Math.max(0, Math.min(this.pos, this.spreads.length - 1)));
    this.slider.classList.toggle('rtl', this.direction === 'rtl');
    let label;
    if (this.pos < 0) label = `始まり / ${n}`;
    else if (this.pos >= this.spreads.length) label = `読了 / ${n}`;
    else {
      const sp = this.spreads[this.pos];
      label = sp.length === 2 ? `${sp[0] + 1}-${sp[1] + 1} / ${n}` : `${sp[0] + 1} / ${n}`;
    }
    this.posEl.textContent = label;
    this.pageNumEl.textContent = label;
    this.pageNumEl.hidden = !settings.showPageNum;
    this.modeBtn.textContent = { auto: '表示：自動', single: '表示：1ページ', double: '表示：2ページ' }[settings.pageMode];
    this.dirBtn.textContent = this.direction === 'rtl' ? '右開き' : '左開き';
    this.shiftBtn.hidden = !this.double;
    this.prevVolBtn.disabled = !this.vols[this.volIndex - 1];
    this.nextVolBtn.disabled = !this.vols[this.volIndex + 1];
  }

  toggleUI() { this.ui.classList.contains('show') ? this.hideUI() : this.showUI(); }
  showUI() { this.updateUI(); this.ui.classList.add('show'); }
  hideUI() { this.ui.classList.remove('show'); }

  onKey(e) {
    const rtl = this.direction === 'rtl';
    switch (e.key) {
      case 'ArrowLeft': rtl ? this.next() : this.prev(); break;
      case 'ArrowRight': rtl ? this.prev() : this.next(); break;
      case 'ArrowDown': case ' ': case 'PageDown': this.next(); break;
      case 'ArrowUp': case 'PageUp': this.prev(); break;
      case 'Escape': this.onExit(); break;
      default: return;
    }
    e.preventDefault();
  }

  // ---------- タップ・スワイプ・ピンチ ----------

  bindGestures() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); if (!this.pointers.size) this.gesture = null; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari のピンチ（ページ全体の拡大）を抑止
    el.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  onDown(e) {
    if (e.target.closest('.r-bar')) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.gesture = { type: 'tap', sx: e.clientX, sy: e.clientY, t: performance.now(), tx0: this.zoom.tx, ty0: this.zoom.ty };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        type: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        s0: this.zoom.s, tx0: this.zoom.tx, ty0: this.zoom.ty,
      };
    }
  }

  onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.gesture) return;
    p.x = e.clientX; p.y = e.clientY;
    const g = this.gesture;
    if (g.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = Math.max(1, Math.min(MAX_ZOOM, g.s0 * d / g.d0));
      // ピンチ開始点の下にあった内容が指の中心に来るように
      const cx = (g.mx - g.tx0) / g.s0, cy = (g.my - g.ty0) / g.s0;
      this.setZoom(s, mx - cx * s, my - cy * s);
      return;
    }
    if (this.pointers.size !== 1) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (g.type === 'tap' && Math.hypot(dx, dy) > 10) g.type = this.zoom.s > 1.01 ? 'pan' : 'swipe';
    if (g.type === 'pan') this.setZoom(this.zoom.s, g.tx0 + dx, g.ty0 + dy);
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch' || g.type === 'after-pinch') {
      if (this.pointers.size === 0) {
        if (this.zoom.s < 1.05) this.resetZoom();
        this.gesture = null;
      } else {
        g.type = 'after-pinch';
      }
      return;
    }
    if (this.pointers.size) return;
    this.gesture = null;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (g.type === 'tap' && performance.now() - g.t < 800) {
      this.onTap(e.clientX);
    } else if (g.type === 'swipe' && settings.swipe && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const forward = this.direction === 'rtl' ? dx > 0 : dx < 0;
      forward ? this.next() : this.prev();
    }
  }

  onTap(x) {
    if (this.ui.classList.contains('show')) { this.hideUI(); return; }
    const w = window.innerWidth;
    const zone = x < w * 0.3 ? 'left' : x > w * 0.7 ? 'right' : 'center';
    if (zone === 'center') { this.toggleUI(); return; }
    let nextSide = 'right';
    if (settings.tapMode === 'left-next') nextSide = 'left';
    else if (settings.tapMode === 'follow') nextSide = this.direction === 'rtl' ? 'left' : 'right';
    zone === nextSide ? this.next() : this.prev();
  }

  setZoom(s, tx, ty) {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    tx = Math.min(0, Math.max(W - W * s, tx));
    ty = Math.min(0, Math.max(H - H * s, ty));
    this.zoom = { s, tx, ty };
    this.stage.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
  }

  resetZoom() { this.setZoom(1, 0, 0); }
}
