// 設定の読み書きとテーマ適用

const KEY = 'manga-viewer-settings';

export const DEFAULTS = {
  theme: 'system',        // system | light | dark
  pageMode: 'auto',       // auto（横向きで2ページ）| single | double
  direction: 'rtl',       // rtl（右開き）| ltr（左開き）
  tapMode: 'right-next',  // right-next | left-next | follow（読む方向に合わせる）
  coverSingle: true,      // 2ページ表示で1ページ目（表紙）を単独表示
  wideSingle: true,       // 横長ページ（見開き画像）は単独表示
  swipe: true,            // スワイプでページ送り
  showPageNum: false,     // ページ番号を常に表示
  preload: 4,             // 先読みする見開き数
  textSize: 'M',          // EPUB の文章の文字サイズ S | M | L | XL
  librarySort: 'recent',  // recent | title
};

export const settings = { ...DEFAULTS };

try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  for (const k of Object.keys(DEFAULTS)) if (k in saved) settings[k] = saved[k];
} catch { /* ストレージが使えない環境 */ }

const listeners = new Set();
export function onSettingsChange(fn) { listeners.add(fn); }

export function setSetting(key, value) {
  settings[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  if (key === 'theme') applyTheme();
  for (const fn of listeners) fn(key, value);
}

const mq = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#111214' : '#f6f5f2';
}
mq.addEventListener?.('change', applyTheme);
