// ファイル／フォルダ／ZIP／EPUB を取り込み、「作品 → 巻 → ページ」に整理して保存する
//
// フォルダ構成の解釈:
//   漫画A/1巻/001.jpg  → 作品「漫画A」, 巻「1巻」
//   漫画A/2巻.zip      → 作品「漫画A」, 巻「2巻」
//   漫画A.zip（中に 1巻/ 2巻/ …）→ 作品「漫画A」
//   漫画A 3巻.epub（単体）→ 作品名をファイル名から推定（「漫画A」）
import * as db from './db.js';
import { readZip } from './zip.js';
import { readEpub } from './epub.js';
import {
  extOf, baseName, dirName, stripExt, isImageName, mimeOf, isJunk,
  naturalCompare, guessSeriesTitle, imageSize, makeThumb, makeTitleThumb,
} from './util.js';

const BATCH = 16;

export async function importFiles(files, { targetSeriesId = null, onProgress = () => {}, askName } = {}) {
  const volumes = new Map();
  const errors = [];
  let skipped = 0;

  const addImage = (path, getBlob) => {
    const d = dirName(path);
    let v = volumes.get(d);
    if (!v) {
      v = { key: d, parent: dirName(d), name: baseName(d), pages: [], needsSort: true, direction: null };
      volumes.set(d, v);
    }
    v.pages.push({ name: path, getBlob });
  };

  // 1. ファイルを走査して巻の候補を作る
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    if (isJunk(path)) continue;
    onProgress({ text: `ファイルを確認中… ${f.name}`, done: i, total: files.length });
    const ext = extOf(path);
    try {
      if (isImageName(path)) {
        addImage(path, () => (f.type ? f : new Blob([f], { type: mimeOf(path) })));
      } else if (ext === 'zip' || ext === 'cbz') {
        const entries = (await readZip(f)).filter((e) => !isJunk(e.name));
        const imgs = entries.filter((e) => isImageName(e.name));
        if (!imgs.length) { errors.push(`${f.name}: 画像が含まれていません`); continue; }
        const tops = new Set(entries.map((e) => (e.name.includes('/') ? e.name.split('/')[0] + '/' : e.name)));
        const singleFolder = tops.size === 1 && [...tops][0].endsWith('/');
        const parent = dirName(path);
        const prefix = (parent ? parent + '/' : '') + (singleFolder ? '' : stripExt(baseName(path)) + '/');
        for (const e of imgs) addImage(prefix + e.name, () => e.getBlob(mimeOf(e.name)));
      } else if (ext === 'epub') {
        const ep = await readEpub(f);
        volumes.set('epub:' + path, {
          key: path, parent: dirName(path), name: stripExt(baseName(path)),
          pages: ep.pages, needsSort: false, direction: ep.direction,
          epub: ep.textMode ? { file: f, ...ep } : null,
        });
      } else {
        skipped++;
      }
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  const list = [...volumes.values()].filter((v) => v.pages.length || v.epub);
  list.sort((a, b) => naturalCompare(a.key, b.key));

  // 2. 作品名・巻名を決める
  const allSeries = await db.getAll('series');
  const target = targetSeriesId ? allSeries.find((s) => s.id === targetSeriesId) : null;

  for (const v of list) {
    if (!v.name) {
      // フォルダ情報のない画像（ファイルを直接選んだ場合）
      if (!target) {
        const s = await askName('作品名を入力してください', '新しい作品');
        if (s == null) { v.skip = true; continue; }
        v.seriesTitle = s.trim() || '新しい作品';
      }
      const n = await askName('巻の名前を入力してください', '1巻');
      if (n == null) { v.skip = true; continue; }
      v.name = n.trim() || '1巻';
    }
    if (target) v.seriesTitle = target.title;
    else if (!v.seriesTitle) v.seriesTitle = v.parent ? baseName(v.parent) : guessSeriesTitle(v.name);
    if (v.needsSort) v.pages.sort((a, b) => naturalCompare(a.name, b.name));
  }

  const todo = list.filter((v) => !v.skip);
  const totalPages = todo.reduce((n, v) => n + (v.epub ? 1 : v.pages.length), 0);
  let donePages = 0;
  let volCount = 0;
  const touchedSeries = new Set();

  // 3. 保存
  for (const v of todo) {
    let series = target || allSeries.find((s) => s.title === v.seriesTitle);
    if (!series) {
      series = {
        id: db.uid(), title: v.seriesTitle,
        direction: v.direction === 'ltr' ? 'ltr' : 'default',
        addedAt: Date.now(), updatedAt: Date.now(),
      };
      await db.put('series', series);
      allSeries.push(series);
    }
    const existing = (await db.getAllByIndex('volumes', 'seriesId', series.id)).find((x) => x.title === v.name);
    const vid = existing ? existing.id : db.uid();
    if (existing) await db.deletePages(vid);

    try {
      if (v.epub) {
        // 文章を含む EPUB はファイルごと保存し、読むときにページ割りする
        const ep = v.epub;
        onProgress({ text: `取り込み中… ${series.title} / ${v.name}`, done: donePages, total: totalPages });
        await db.putPages(vid, [{ index: 0, blob: new Blob([ep.file], { type: 'application/epub+zip' }) }]);
        let thumb = null;
        if (ep.getCover) { try { thumb = await makeThumb(await ep.getCover()); } catch { /* 表紙なし */ } }
        if (!thumb) thumb = await makeTitleThumb(v.name);
        await db.put('volumes', {
          id: vid, seriesId: series.id, title: v.name, kind: 'epub',
          pageCount: ep.sectionSizes.length, sectionSizes: ep.sectionSizes,
          dims: [], thumb, addedAt: existing ? existing.addedAt : Date.now(),
        });
        donePages++;
        volCount++;
        touchedSeries.add(series.id);
        continue;
      }
      const dims = [];
      let thumb = null;
      let batch = [];
      for (let i = 0; i < v.pages.length; i++) {
        let blob = await v.pages[i].getBlob();
        if (!blob.type) blob = new Blob([blob], { type: mimeOf(v.pages[i].name) });
        const s = await imageSize(blob);
        dims.push([s.w, s.h]);
        if (i === 0) thumb = await makeThumb(blob);
        batch.push({ index: i, blob });
        if (batch.length >= BATCH) { await db.putPages(vid, batch); batch = []; }
        donePages++;
        onProgress({ text: `取り込み中… ${series.title} / ${v.name}（${i + 1}/${v.pages.length}）`, done: donePages, total: totalPages });
      }
      if (batch.length) await db.putPages(vid, batch);
      await db.put('volumes', {
        id: vid, seriesId: series.id, title: v.name, pageCount: v.pages.length,
        dims, thumb, addedAt: existing ? existing.addedAt : Date.now(),
      });
      volCount++;
      touchedSeries.add(series.id);
    } catch (err) {
      await db.deletePages(vid).catch(() => {});
      if (existing) await db.del('volumes', vid).catch(() => {});
      errors.push(`${series.title} / ${v.name}: ${err.message}`);
    }
  }

  for (const id of touchedSeries) {
    const s = allSeries.find((x) => x.id === id);
    s.updatedAt = Date.now();
    await db.put('series', s);
  }

  return { volumes: volCount, series: touchedSeries.size, pages: donePages, errors, skipped };
}
