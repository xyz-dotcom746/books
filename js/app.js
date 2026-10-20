import * as db from './db.js';
import { settings, setSetting, applyTheme, onSettingsChange } from './settings.js';
import { importFiles } from './importer.js';
import { Reader } from './reader.js';
import { naturalCompare, escapeHtml, formatBytes } from './util.js';

const $ = (id) => document.getElementById(id);
const views = { library: $('library'), series: $('series'), reader: $('reader') };

applyTheme();

// ---------- 共通 UI ----------

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function showSheet(title, actions) {
  const sheet = $('action-sheet');
  $('action-title').textContent = title || '';
  $('action-title').hidden = !title;
  const list = $('action-list');
  list.replaceChildren();
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-item' + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => { sheet.hidden = true; a.fn(); });
    list.appendChild(b);
  }
  sheet.hidden = false;
}
$('action-cancel').addEventListener('click', () => { $('action-sheet').hidden = true; });
$('action-sheet').addEventListener('click', (e) => { if (e.target.id === 'action-sheet') $('action-sheet').hidden = true; });

function setBusy(text, ratio) {
  $('busy').hidden = text == null;
  if (text != null) {
    $('busy-text').textContent = text;
    $('busy-bar').style.width = `${Math.round((ratio || 0) * 100)}%`;
  }
}

const thumbUrls = new Map();
function thumbUrl(vol) {
  if (!vol || !vol.thumb) return '';
  let u = thumbUrls.get(vol.id);
  if (!u) { u = URL.createObjectURL(vol.thumb); thumbUrls.set(vol.id, u); }
  return u;
}
function dropThumb(id) {
  const u = thumbUrls.get(id);
  if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); }
}

// ---------- 画面遷移（ハッシュルーティング） ----------

let depth = 0;
let pendingOpenAt = 'resume';

function go(hash) { depth++; location.hash = hash; }
function goBack(fallback) {
  if (depth > 0) { depth--; history.back(); } else location.replace(fallback);
}

function showView(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  document.body.classList.toggle('reading', name === 'reader');
}

let routedHash = null;

async function route(force = false) {
  const hash = location.hash || '#/';
  if (!force && hash === routedHash) return;
  routedHash = hash;
  const [, a, b] = (hash.slice(1) || '/').split('/');
  if (a === 'read' && b) {
    showView('reader');
    const at = pendingOpenAt;
    pendingOpenAt = 'resume';
    try { await reader.open(decodeURIComponent(b), at); }
    catch (e) { toast(e.message); location.replace('#/'); }
    return;
  }
  if (reader.active) reader.close();
  if (a === 'series' && b) {
    showView('series');
    await renderSeries(decodeURIComponent(b));
  } else {
    showView('library');
    await renderLibrary();
  }
}

function openVolume(vid, at = 'resume') {
  pendingOpenAt = at;
  go('#/read/' + encodeURIComponent(vid));
}

const reader = new Reader({
  toast,
  showSheet,
  onExit: () => goBack('#/series/' + encodeURIComponent(reader.vol.seriesId)),
  onOpenSettings: () => openSettings(),
  onVolumeChange: (vid) => {
    routedHash = '#/read/' + encodeURIComponent(vid);
    history.replaceState(null, '', routedHash);
  },
});

// ---------- 続きから読む ----------

// 作品の中で次に読むべき巻を決める
function nextToRead(vols, progMap) {
  let latest = null;
  for (const v of vols) {
    const p = progMap.get(v.id);
    if (p && (!latest || p.updatedAt > latest.p.updatedAt)) latest = { v, p };
  }
  if (!latest) return vols[0] ? { vol: vols[0], at: 'resume', label: `${vols[0].title} から読む` } : null;
  const { v, p } = latest;
  if (p.finished) {
    const i = vols.indexOf(v);
    const nv = vols[i + 1];
    if (nv) return { vol: nv, at: 'resume', label: `${nv.title} から読む` };
    return { vol: v, at: 'resume', label: `${v.title} を最初から読む（読了）` };
  }
  if (v.kind === 'epub') return { vol: v, at: 'resume', label: `${v.title} の ${Math.round((p.percent || 0) * 100)}% から` };
  return { vol: v, at: 'resume', label: `${v.title} の ${p.page + 1}ページから` };
}

// ---------- 本棚 ----------

async function renderLibrary() {
  const [series, volumes, progress] = await Promise.all([db.getAll('series'), db.getAll('volumes'), db.getAll('progress')]);
  const progMap = new Map(progress.map((p) => [p.volumeId, p]));
  const bySeries = new Map();
  for (const v of volumes) {
    if (!bySeries.has(v.seriesId)) bySeries.set(v.seriesId, []);
    bySeries.get(v.seriesId).push(v);
  }
  const items = series.map((s) => {
    const vols = (bySeries.get(s.id) || []).sort((a, b) => naturalCompare(a.title, b.title));
    let lastRead = 0;
    for (const v of vols) { const p = progMap.get(v.id); if (p && p.updatedAt > lastRead) lastRead = p.updatedAt; }
    return { s, vols, lastRead };
  }).filter((x) => x.vols.length);

  $('lib-sort').value = settings.librarySort;
  if (settings.librarySort === 'title') items.sort((a, b) => naturalCompare(a.s.title, b.s.title));
  else items.sort((a, b) => (b.lastRead || b.s.updatedAt) - (a.lastRead || a.s.updatedAt));

  const q = $('lib-search').value.trim().normalize('NFKC').toLowerCase();
  const shown = q ? items.filter((x) => x.s.title.normalize('NFKC').toLowerCase().includes(q)) : items;

  // 続きを読むバナー
  const cont = $('continue');
  const recent = items.filter((x) => x.lastRead).sort((a, b) => b.lastRead - a.lastRead)[0];
  const next = recent && nextToRead(recent.vols, progMap);
  if (next) {
    cont.hidden = false;
    cont.innerHTML = `
      <img class="continue-thumb" src="${thumbUrl(next.vol)}" alt="">
      <div class="continue-body">
        <div class="continue-label">続きを読む</div>
        <div class="continue-title">${escapeHtml(recent.s.title)}</div>
        <div class="continue-sub">${escapeHtml(next.label)}</div>
      </div>
      <span class="continue-go">›</span>`;
    cont.onclick = () => openVolume(next.vol.id, next.at);
  } else {
    cont.hidden = true;
  }

  const grid = $('series-grid');
  grid.replaceChildren(...shown.map(({ s, vols }) => {
    const done = vols.filter((v) => progMap.get(v.id)?.completed).length;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.innerHTML = `
      <div class="cover"><img src="${thumbUrl(vols[0])}" alt="" loading="lazy"></div>
      <div class="card-title">${escapeHtml(s.title)}</div>
      <div class="card-meta">${vols.length}冊${done ? `・${done}冊読了` : ''}</div>`;
    card.addEventListener('click', () => go('#/series/' + encodeURIComponent(s.id)));
    return card;
  }));
  $('lib-empty').hidden = items.length > 0;
}

$('lib-search').addEventListener('input', () => renderLibrary());
$('lib-sort').addEventListener('change', (e) => { setSetting('librarySort', e.target.value); renderLibrary(); });
$('lib-settings').addEventListener('click', () => openSettings());
$('lib-add').addEventListener('click', () => chooseImport(null));

// ---------- 作品画面 ----------

let currentSeries = null;

async function renderSeries(id) {
  const s = await db.get('series', id);
  if (!s) { location.replace('#/'); return; }
  currentSeries = s;
  const vols = (await db.getAllByIndex('volumes', 'seriesId', id)).sort((a, b) => naturalCompare(a.title, b.title));
  const prog = await db.getAllByIndex('progress', 'seriesId', id);
  const progMap = new Map(prog.map((p) => [p.volumeId, p]));

  $('series-title').textContent = s.title;
  $('series-dir').value = s.direction || 'default';

  const next = nextToRead(vols, progMap);
  const contBtn = $('series-continue');
  contBtn.hidden = !next;
  if (next) {
    contBtn.textContent = progMap.size ? `続きから読む：${next.label}` : `読む：${next.vol.title}`;
    contBtn.onclick = () => openVolume(next.vol.id, next.at);
  }

  const grid = $('volume-grid');
  grid.replaceChildren(...vols.map((v) => {
    const p = progMap.get(v.id);
    let status = '未読';
    let ratio = 0;
    if (p && p.finished) { status = '読了'; ratio = 1; }
    else if (p && v.kind === 'epub') { ratio = p.percent || 0; status = `${Math.round(ratio * 100)}%`; }
    else if (p) { status = `${p.page + 1} / ${v.pageCount}`; ratio = (p.page + 1) / v.pageCount; }
    else status = v.kind === 'epub' ? '未読' : `${v.pageCount}ページ`;
    if (p && p.completed && !p.finished) status += '（再読中）';

    const card = document.createElement('div');
    card.className = 'card vol';
    card.innerHTML = `
      <button type="button" class="card-open">
        <div class="cover"><img src="${thumbUrl(v)}" alt="" loading="lazy">${p && p.completed ? '<span class="badge">読了</span>' : ''}</div>
        <div class="card-title">${escapeHtml(v.title)}</div>
        <div class="bar"><div style="width:${Math.round(ratio * 100)}%"></div></div>
        <div class="card-meta">${escapeHtml(status)}</div>
      </button>
      <button type="button" class="vol-more" aria-label="その他">•••</button>`;
    card.querySelector('.card-open').addEventListener('click', () => openVolume(v.id, 'resume'));
    card.querySelector('.vol-more').addEventListener('click', () => volumeMenu(v, p));
    return card;
  }));
}

function volumeMenu(v, p) {
  showSheet(`${currentSeries.title}　${v.title}`, [
    { label: '最初から読む', fn: () => openVolume(v.id, 0) },
    { label: '既読にする', fn: async () => {
      await db.put('progress', { volumeId: v.id, seriesId: v.seriesId, page: v.pageCount - 1, total: v.pageCount, finished: true, completed: true, updatedAt: Date.now() });
      renderSeries(v.seriesId);
    } },
    { label: '未読に戻す', fn: async () => { await db.del('progress', v.id); renderSeries(v.seriesId); } },
    { label: '名前を変更', fn: async () => {
      const name = prompt('巻の名前', v.title);
      if (name && name.trim()) { v.title = name.trim(); await db.put('volumes', v); renderSeries(v.seriesId); }
    } },
    { label: 'この巻を削除', danger: true, fn: async () => {
      if (!confirm(`「${v.title}」を削除しますか？`)) return;
      await db.deleteVolume(v.id);
      dropThumb(v.id);
      const rest = await db.getAllByIndex('volumes', 'seriesId', v.seriesId);
      if (!rest.length) { await db.del('series', v.seriesId); location.replace('#/'); }
      else renderSeries(v.seriesId);
    } },
  ]);
}

$('series-back').addEventListener('click', () => goBack('#/'));
$('series-add').addEventListener('click', () => chooseImport(currentSeries.id));
$('series-dir').addEventListener('change', async (e) => {
  currentSeries.direction = e.target.value;
  await db.put('series', currentSeries);
  toast('読む方向を変更しました');
});
$('series-more').addEventListener('click', () => {
  const s = currentSeries;
  showSheet(s.title, [
    { label: '作品名を変更', fn: async () => {
      const name = prompt('作品名', s.title);
      if (name && name.trim()) { s.title = name.trim(); await db.put('series', s); renderSeries(s.id); }
    } },
    { label: 'すべて未読に戻す', fn: async () => {
      for (const p of await db.getAllByIndex('progress', 'seriesId', s.id)) await db.del('progress', p.volumeId);
      renderSeries(s.id);
    } },
    { label: 'この作品を削除', danger: true, fn: async () => {
      if (!confirm(`「${s.title}」のすべての巻を削除しますか？`)) return;
      const vols = await db.getAllByIndex('volumes', 'seriesId', s.id);
      setBusy('削除中…', 0);
      await db.deleteSeries(s.id);
      setBusy(null);
      vols.forEach((v) => dropThumb(v.id));
      location.replace('#/');
    } },
  ]);
});

// ---------- 取り込み ----------

let importTarget = null;

function chooseImport(seriesId) {
  importTarget = seriesId;
  showSheet(seriesId ? '巻を追加' : '漫画を追加', [
    { label: 'ファイルを選択（画像・ZIP・CBZ・EPUB）', fn: () => $('file-input').click() },
    { label: 'フォルダを選択', fn: () => $('folder-input').click() },
  ]);
}

async function runImport(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  navigator.storage?.persist?.().catch(() => {});
  setBusy('準備中…', 0);
  try {
    const r = await importFiles(files, {
      targetSeriesId: importTarget,
      onProgress: ({ text, done, total }) => setBusy(text, total ? done / total : 0),
      askName: async (msg, def) => { setBusy(null); const v = prompt(msg, def); setBusy('取り込み中…', 0); return v; },
    });
    setBusy(null);
    if (r.volumes) toast(`${r.series}作品・${r.volumes}冊（${r.pages}ページ）を取り込みました`, 3500);
    else if (!r.errors.length) toast('取り込める画像が見つかりませんでした', 3500);
    if (r.errors.length) alert('一部のファイルを取り込めませんでした:\n\n' + r.errors.slice(0, 15).join('\n'));
  } catch (e) {
    setBusy(null);
    alert('取り込みに失敗しました: ' + e.message);
  }
  route(true);
}

for (const id of ['file-input', 'folder-input']) {
  $(id).addEventListener('change', async (e) => {
    const files = e.target.files;
    await runImport(files);
    e.target.value = '';
  });
}

// ---------- 設定 ----------

function seg(key, options) {
  return `<div class="seg" data-key="${key}">${options.map(([v, l]) =>
    `<button type="button" data-value="${v}" class="${String(settings[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function toggle(key) {
  return `<label class="switch"><input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}><span></span></label>`;
}
function row(label, control, note = '') {
  return `<div class="row"><div class="row-label">${label}${note ? `<div class="row-note">${note}</div>` : ''}</div><div class="row-control">${control}</div></div>`;
}

async function openSettings() {
  const body = $('settings-body');
  body.innerHTML = `
    <h3>外観</h3>
    ${row('テーマ', seg('theme', [['system', 'システム'], ['light', 'ライト'], ['dark', 'ダーク']]))}
    <h3>ページ表示</h3>
    ${row('表示ページ数', seg('pageMode', [['auto', '自動'], ['single', '1ページ'], ['double', '2ページ']]), '自動：横向きで2ページ、縦向きで1ページ')}
    ${row('読む方向', seg('direction', [['rtl', '右開き'], ['ltr', '左開き']]), '作品ごとに変更することもできます')}
    ${row('表紙を単独で表示', toggle('coverSingle'), '2ページ表示のとき1ページ目を1枚で表示')}
    ${row('横長のページを単独で表示', toggle('wideSingle'), '見開きで描かれた画像を1枚で表示')}
    ${row('ページ番号を常に表示', toggle('showPageNum'))}
    <h3>操作</h3>
    ${row('タップでページ送り', seg('tapMode', [['right-next', '右で次へ'], ['left-next', '左で次へ'], ['follow', '読む方向に合わせる']]), '画面の中央をタップするとメニューを表示')}
    ${row('スワイプでページ送り', toggle('swipe'))}
    ${row('文字サイズ', seg('textSize', [['S', '小'], ['M', '中'], ['L', '大'], ['XL', '特大']]), '文章を含む EPUB（小説など）の文字の大きさ')}
    ${row('先読み', seg('preload', [[2, '少なめ'], [4, '標準'], [8, '多め']]), '多いほどページ送りが速くなりますがメモリを使います')}
    <h3>データ</h3>
    <div class="row"><div class="row-label">使用容量<div class="row-note" id="storage-info">計算中…</div></div></div>
    <div class="row"><button type="button" class="btn danger" id="clear-all">すべてのデータを削除</button></div>
    <h3>使い方</h3>
    <div class="help">
      <p><b>取り込み：</b>「＋ 追加」から画像・ZIP・CBZ・EPUB を選びます。「漫画A」フォルダの中に「1巻」「2巻」…のフォルダがある構成を ZIP にまとめて取り込むと、作品と巻が自動で整理されます。</p>
      <p><b>読む：</b>画面の左右をタップでページ送り、中央タップでメニュー。2本指で拡大できます。巻の最後で「次へ」をタップすると次の巻に進みます。</p>
      <p><b>続きから：</b>読んだ位置は自動で記録されます。</p>
      <p><b>ホーム画面に追加：</b>Safari の共有ボタン →「ホーム画面に追加」で全画面のアプリとして使えます。</p>
    </div>`;

  body.querySelectorAll('.seg').forEach((el) => {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const key = el.dataset.key;
      const raw = b.dataset.value;
      setSetting(key, typeof settings[key] === 'number' ? Number(raw) : raw);
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  body.querySelectorAll('input[type=checkbox]').forEach((el) => {
    el.addEventListener('change', () => setSetting(el.dataset.key, el.checked));
  });
  $('clear-all').addEventListener('click', async () => {
    if (!confirm('取り込んだ漫画と読書記録をすべて削除します。よろしいですか？')) return;
    setBusy('削除中…', 0);
    await db.clearAll();
    setBusy(null);
    for (const id of [...thumbUrls.keys()]) dropThumb(id);
    closeSettings();
    location.replace('#/');
    route(true);
  });

  $('settings').hidden = false;

  try {
    const est = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    $('storage-info').textContent = `${formatBytes(est.usage)} 使用中 / 上限の目安 ${formatBytes(est.quota)}${persisted ? '（保護済み）' : ''}`;
  } catch {
    $('storage-info').textContent = '取得できませんでした';
  }
}

function closeSettings() { $('settings').hidden = true; }
$('settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });

onSettingsChange((key) => {
  if (!reader.active) return;
  if (['pageMode', 'coverSingle', 'wideSingle', 'direction', 'textSize'].includes(key)) reader.relayout();
  else if (key === 'theme' && reader.mode === 'text') reader.relayout();
  else reader.updateUI();
});

// ---------- イベント ----------

document.addEventListener('keydown', (e) => {
  if (!reader.active || !$('settings').hidden || !$('action-sheet').hidden) return;
  reader.onKey(e);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => reader.relayout(), 80);
});

document.addEventListener('visibilitychange', () => { if (document.hidden) reader.flushSave(); });
window.addEventListener('pagehide', () => reader.flushSave());
// 履歴をたどったとき hashchange が来ない場合があるので popstate も監視
window.addEventListener('hashchange', () => route());
window.addEventListener('popstate', () => route());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

route(true);

// デバッグ・テスト用
window.__manga = { importFiles, db, reader, route };
