import {
  formatDurationShort,
  formatLatency,
  formatTokens,
  mask,
  STATE_WORDS,
} from './presenter.js';
import { brandKey, brandMark } from './brand-icons.mjs';
import { downloadSize } from './download-progress.mjs';
import { redactDiagnostic } from './redact.mjs';
import { providerSessionGroups } from './model-sessions.mjs';
import { plansByProvider, windowLabel } from './plan-quota.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  live: $('live'),
  liveState: $('liveState'),
  gateway: $('gateway'),
  appVersion: $('appVersion'),
  stageArea: $('stageArea'),
  stageCanvas: $('stageCanvas'),
  tokenPill: $('tokenPill'),
  tokenTotal: $('tokenTotal'),
  tokenWindow: $('tokenWindow'),
  providerGroups: $('providerGroups'),
  modelEmpty: $('modelEmpty'),
  modelHidden: $('modelHidden'),
};

let settings = {
  maskAccounts: true,
  gateway: '127.0.0.1:3425',
  usagePeriod: '30d',
  enabledPeriods: ['today', '7d', '30d', 'all'],
  pillMetric: 'total',
  rollTokens: true,
  showTiming: true,
  fontSize: 'normal',
};
let lastTrace = null;
let usageData = null;
let usageStatus = { loading: false, stale: false, at: 0, error: '' };
let plans = new Map();
let connection = { online: false, detail: '正在连接' };
let layout = false;
let frame = { cardHeight: 400, windowHeight: 216 };

const numberAnimations = new WeakMap();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionReduced = () => Boolean(settings.quietMotion || reducedMotion.matches);

// The plans the gateway reported, as one list per provider. Replaced whole on
// every read: a provider that stopped reporting windows must not keep showing
// the ones from before.
function setPlans(entries) {
  plans = plansByProvider(entries);
}

function iconSetup() {
  const icons = window.busy.icons || {};
  const openai = $('openaiPath');
  const deepseek = $('deepseekPath');
  if (icons.magpie) $('aboutBirdPath').setAttribute('d', icons.magpie);
  if (icons.openai) openai.setAttribute('d', icons.openai);
  if (icons.deepseek) deepseek.setAttribute('d', icons.deepseek);
}

function applyFrame(next) {
  if (!next || !next.windowHeight) return;
  const compactChanged = Boolean(frame.compact) !== Boolean(next.compact);
  frame = { ...frame, ...next };
  document.body.classList.toggle('compact', Boolean(frame.compact));
  const root = document.documentElement;
  root.style.setProperty('--window-h', `${frame.windowHeight}px`);
  root.style.setProperty('--card-h', `${frame.cardHeight}px`);
  requestAnimationFrame(() => {
    applyUiScale();
    if (compactChanged) render();
  });
}

// The card is drawn on a fixed canvas and scaled to fit the window, so a
// bigger window means bigger text, nodes and wires rather than empty space.
// The canvas is 500x333 rather than 600x400: at the default 316x221 window the
// smaller canvas lands on --ui 0.56, which keeps the 20px name row at ~11.2px
// and the 16px measurements at ~9px on screen instead of the ~9.4/7.5px the
// bigger canvas produced.
const CANVAS_W = 500;
const CANVAS_H = 333;

// The font setting is a content zoom rather than a pile of font-size rules:
// the canvas shrinks by this factor, the window does not, so the same 20px
// name lands bigger on screen (and every row, gap and icon with it). `small`
// keeps the name near 10px, `xlarge` lifts it to ~15px.
const FONT_ZOOM = { small: 0.88, normal: 1, large: 1.16, xlarge: 1.34 };

function fontZoom() {
  return FONT_ZOOM[settings.fontSize] || 1;
}

function uiScale() {
  return Number(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
}

function applyUiScale() {
  const area = el.stageArea?.getBoundingClientRect();
  if (!area || area.width < 40 || area.height < 40) return;
  const zoom = fontZoom();
  const canvasW = CANVAS_W / zoom;
  const canvasH = CANVAS_H / zoom;
  const root = document.documentElement;
  root.style.setProperty('--canvas-w', `${canvasW.toFixed(2)}px`);
  root.style.setProperty('--canvas-h', `${canvasH.toFixed(2)}px`);
  root.style.setProperty('--font-zoom', String(zoom));
  const scale = Math.max(
    0.3,
    Math.min(2.6, Math.min(area.width / canvasW, area.height / canvasH)),
  );
  document.documentElement.style.setProperty('--ui', scale.toFixed(4));
  requestAnimationFrame(reportHitAreas);
}

function usageTotal(data) {
  if (!data) return 0;
  return (Number(data.input) || 0)
    + (Number(data.output) || 0)
    + (Number(data.cache_read) || 0)
    + (Number(data.cache_write) || 0);
}

// The four windows magpie answers, in the order a click on the pill walks
// them. The short form is what the pill shows; the long one is the tooltip.
const USAGE_PERIODS = ['today', '7d', '30d', 'all'];
const PERIOD_SHORT = { today: '今日', '7d': '7 天', '30d': '30 天', all: '全部' };
const PERIOD_LONG = { today: '今日', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };

// What the pill's rolling number counts: the whole total, or one part of it.
const PILL_METRICS = {
  total: { label: '总 token', pick: usageTotal },
  input: { label: '输入 token', pick: (data) => Number(data.input) || 0 },
  output: { label: '输出 token', pick: (data) => Number(data.output) || 0 },
  cache: { label: '缓存读取', pick: (data) => Number(data.cache_read) || 0 },
};

function pillMetric() {
  return PILL_METRICS[settings.pillMetric] ? settings.pillMetric : 'total';
}

// The windows a click on the pill walks: only the ones switched on, in the
// order today, week, month, all. At least one always survives.
function cyclePeriods() {
  const kept = Array.isArray(settings.enabledPeriods)
    ? settings.enabledPeriods.filter((period) => USAGE_PERIODS.includes(period))
    : [];
  return kept.length ? kept : USAGE_PERIODS.slice();
}

function activePeriod() {
  const fromUsage = String(usageData?.period || '').toLowerCase();
  if (USAGE_PERIODS.includes(fromUsage)) return fromUsage;
  return USAGE_PERIODS.includes(settings.usagePeriod) ? settings.usagePeriod : '30d';
}

function usagePeriod(data) {
  const period = String(data?.period || '');
  const days = /^(\d+)d$/.exec(period);
  if (days) return `近 ${days[1]} 天`;
  if (period === '24h') return '近 24 小时';
  if (period === 'today') return '今日';
  if (period === 'all') return '全部';
  return '总计';
}

function applyUsageTokens() {
  if (usageData) {
    const metricKey = pillMetric();
    const metric = PILL_METRICS[metricKey];
    const value = metric.pick(usageData);
    const input = Number(usageData.input) || 0;
    const output = Number(usageData.output) || 0;
    const cache = Number(usageData.cache_read) || 0;
    const cacheRate = input + cache > 0 ? cache / (input + cache) : null;
    const period = activePeriod();
    applyTokenPill({
      total: value,
      windowLabel: `${PERIOD_SHORT[period] || ''}${metricKey === 'total' ? '' : ` · ${{ input: '输入', output: '输出', cache: '缓存' }[metricKey]}`}`,
      title: `${PERIOD_LONG[period] || usagePeriod(usageData)} · ${metric.label} ${formatTokens(value)}`
        + ` · ${Number(usageData.calls || 0).toLocaleString()} 请求`
        + `\n输入 ${formatTokens(input)} · 输出 ${formatTokens(output)}`
        + ` · 缓存 ${formatTokens(cache)}${cacheRate !== null ? `（${Math.round(cacheRate * 100)}%）` : ''}`
        + '\n单击切换时间窗',
    });
    return;
  }

  // No usage log: fall back to what the trace itself carried.
  const recent = Array.isArray(lastTrace?.routes) ? lastTrace.routes : [];
  const fallback = recent.reduce((sum, route) => (
    sum + (Number(route.tokens) || Number(route.prompt?.tokens) || 0)
  ), 0);
  applyTokenPill({
    total: fallback,
    windowLabel: '近期快照',
    title: `最近 ${recent.length} 个请求合计 ${formatTokens(fallback)}`,
  });
}

function renderUsageStatus() {
  const label = $('usageStatus');
  const at = usageStatus.at ? new Date(usageStatus.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  label.classList.toggle('stale', Boolean(usageStatus.error || usageStatus.stale));
  label.textContent = usageStatus.loading ? `正在读取${PERIOD_SHORT[usageStatus.period] || '用量'}…`
    : usageStatus.error ? (usageStatus.stale ? `暂未刷新 · 上次 ${at || '—'}` : '用量暂不可用')
      : at ? `更新于 ${at}` : '等待用量数据';
  label.title = usageStatus.error || '上方为所选时间窗的用量；下方请求数为网关本次启动以来累计';
}

let tokenText = '';
const TOKEN_DIGIT_H = 21;

function staticTokenTrack(char) {
  const track = document.createElement('span');
  track.className = 'token-track';
  const digit = document.createElement('span');
  digit.className = 'token-digit';
  digit.textContent = char;
  track.append(digit);
  return track;
}

function setTokenTotal(text, animate = true) {
  if (!el.tokenTotal || !text) return;
  if (text === tokenText) return;
  const old = tokenText;
  tokenText = text;

  if (!animate) {
    const plain = document.createElement('span');
    plain.className = 'token-plain';
    plain.textContent = text;
    el.tokenTotal.replaceChildren(plain);
    return;
  }

  const roll = document.createElement('span');
  roll.className = 'token-roll';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const col = document.createElement('span');
    col.className = `token-col${char === '.' ? ' token-col-dot' : ''}`;
    if (!/\d/.test(char)) {
      col.append(staticTokenTrack(char));
      roll.append(col);
      continue;
    }

    const track = document.createElement('span');
    track.className = 'token-track';
    for (let n = 0; n < 20; n++) {
      const digit = document.createElement('span');
      digit.className = 'token-digit';
      digit.textContent = String(n % 10);
      track.append(digit);
    }
    col.append(track);
    roll.append(col);

    if (!old || old.length !== text.length || !/\d/.test(old[i])) {
      track.style.transition = 'none';
      track.style.transform = `translateY(${-Number(char) * TOKEN_DIGIT_H}px)`;
      continue;
    }
    const from = Number(old[i]);
    const to = Number(char);
    if (from === to) {
      track.style.transition = 'none';
      track.style.transform = `translateY(${-to * TOKEN_DIGIT_H}px)`;
      continue;
    }
    // A carry still rolls upward: 9 -> 0 goes through the repeated 0 row.
    const target = to < from ? to + 10 : to;
    track.style.transition = 'none';
    track.style.transform = `translateY(${-from * TOKEN_DIGIT_H}px)`;
    void track.offsetHeight;
    requestAnimationFrame(() => {
      track.style.transition = '';
      track.style.transform = `translateY(${-target * TOKEN_DIGIT_H}px)`;
      window.setTimeout(() => {
        track.style.transition = 'none';
        track.style.transform = `translateY(${-to * TOKEN_DIGIT_H}px)`;
      }, 600);
    });
  }

  el.tokenTotal.replaceChildren(roll);
}

function applyTokenPill({ total = 0, title = '', windowLabel = '' } = {}) {
  $('compactTotal').textContent = usageData ? formatTokens(total) : '—';
  $('compactPeriod').textContent = windowLabel;
  $('compactPill').title = title || '单击切换时间窗';
  if (!el.tokenPill) return;
  // A usage summary is shown even at zero, so the pill stays reachable and
  // the next click can walk back out of an empty window.
  if (!total && !usageData) {
    el.tokenPill.hidden = true;
    requestAnimationFrame(reportHitAreas);
    return;
  }
  el.tokenPill.hidden = false;
  const text = formatTokens(total);
  setTokenTotal(text, settings.rollTokens !== false && !motionReduced());
  if (el.tokenWindow) el.tokenWindow.textContent = windowLabel;
  el.tokenPill.title = title || `${text} token`;
  requestAnimationFrame(reportHitAreas);
}

// Main uses scaled control bounds for hover, dragging and resizing.
let lastHitKey = '';

function reportHitAreas() {
  if (!window.busy?.setHitAreas) return;
  const canvas = el.stageCanvas?.getBoundingClientRect();
  if (!canvas) return;
  const scale = uiScale();
  const rectangle = (node) => {
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
  };
  const controls = [el.tokenPill, el.appVersion, $('updateChip'), $('cardClose'), $('quickMenuToggle'), $('compactPill'), $('compactExpand'), $('compactMenu')]
    .filter((node) => node && !node.hidden && node.isConnected)
    .map(rectangle)
    // A model row is a button too: main needs its rectangle to treat the
    // pointer as being over a control, which is also what lets the window take
    // focus so the keyboard can open a row.
    .concat([...el.providerGroups.querySelectorAll('.model-row')].map(rectangle));
  const payload = {
    controls,
    resize: [...document.querySelectorAll('.resize-handle')].map(rectangle),
    dragTop: Math.round((frame.compact ? $('compactDragBar') : $('dragBar')).getBoundingClientRect().top),
    dragBottom: Math.round((frame.compact ? $('compactDragBar') : $('dragBar')).getBoundingClientRect().bottom),
    ui: Number(scale.toFixed(4)),
  };
  const key = JSON.stringify(payload);
  if (key === lastHitKey) return;
  lastHitKey = key;
  window.busy.setHitAreas(payload);
}

function setupQuickMenu() {
  const button = $('quickMenuToggle');
  const menu = $('quickMenu');
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  let open = false;

  button.addEventListener('click', () => window.busy.toggleMenu());
  $('compactMenu').addEventListener('click', () => window.busy.toggleMenu());
  $('compactExpand').addEventListener('click', () => window.busy.toggleCompact());
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-menu-action]');
    if (item) window.busy.menuAction(item.dataset.menuAction);
  });

  const outside = (event) => open && !menu.contains(event.target) && !button.contains(event.target);
  // Consume the entire outside click before dismissing the menu.
  // In particular, pressing the drag bar must only dismiss this menu.
  document.addEventListener('pointerdown', (event) => {
    if (!outside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('click', (event) => {
    if (!outside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.busy.closeMenu();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (!open) return;
    const current = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current + items.length - 1) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape' || event.key === 'Tab') window.busy.closeMenu();
    else return;
    event.preventDefault();
    if (next !== undefined) items[next].focus();
  });

  window.busy.onQuickMenu((value) => {
    open = Boolean(value);
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    $('compactMenuItem').textContent = settings.compact ? '展开主界面' : '紧凑模式';
    document.body.classList.toggle('menu-open', open);
    $('quickMenuError').hidden = true;
    if (open) items[0].focus({ preventScroll: true });
    else if (menu.contains(document.activeElement)) button.focus({ preventScroll: true });
  });
  window.busy.onActionError((error) => {
    $('quickMenuError').textContent = error;
    $('quickMenuError').hidden = false;
  });
  new ResizeObserver(() => requestAnimationFrame(reportHitAreas)).observe(button.parentElement);
}

function setupTokenPill() {
  const pill = el.tokenPill;
  if (!pill || !window.busy?.setUsagePeriod) return;

  let switching = false;

  const cycle = async () => {
    if (switching || document.body.classList.contains('settings-open')) return;
    const enabled = cyclePeriods();
    const current = activePeriod();
    const next = enabled[(enabled.indexOf(current) + 1) % enabled.length] || enabled[0];
    switching = true;
    pill.classList.add('switching');
    try {
      const result = await window.busy.setUsagePeriod(next);
      if (result?.usage) {
        usageData = result.usage;
        applyUsageTokens();
      }
    } catch {
      // A failed switch leaves the pill on the window it was showing.
    } finally {
      switching = false;
      pill.classList.remove('switching');
    }
  };
  pill.addEventListener('click', cycle);
  $('compactPill').addEventListener('click', cycle);

  new ResizeObserver(() => requestAnimationFrame(reportHitAreas)).observe(pill);
  requestAnimationFrame(reportHitAreas);
}

function create(tag, className, text) {  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setParts(target, parts) {
  target.replaceChildren();
  for (const part of parts || []) {
    const span = document.createElement('span');
    if (part.role && part.role !== 'normal') span.className = part.role;
    span.textContent = part.text;
    target.append(span);
  }
}

// ── magpies that carry a request along the wires ───────────────────────
// Ported from magpie's routing page: a request flies from its agent through
// magpie to the chosen account, then an answer flies back. The bird is
// flipped when travelling left and banked into the curve.

function setupDragBar(bar = $('dragBar')) {
  if (!bar || !window.busy?.dragStart) return;
  let press = null;
  let dragging = false;
  let suppressClick = false;

  const cancelPress = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  };

  const finish = (event) => {
    cancelPress();
    if (dragging) {
      dragging = false;
      bar.classList.remove('dragging');
      window.busy.dragEnd();
      window.setTimeout(() => { suppressClick = false; }, 420);
    }
    if (event && bar.hasPointerCapture?.(event.pointerId)) {
      bar.releasePointerCapture(event.pointerId);
    }
  };

  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      bar.setPointerCapture(event.pointerId);
    } catch {
      // A release that lands outside the window still ends the drag.
    }
    press = {
      x: event.clientX,
      y: event.clientY,
      timer: 0,
    };
    press.timer = window.setTimeout(() => {
      if (!press) return;
      press = null;
      dragging = true;
      suppressClick = true;
      bar.classList.add('dragging');
      window.busy.dragStart();
    }, 150);
  });

  bar.addEventListener('pointermove', (event) => {
    if (!press) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 9) {
      cancelPress();
    }
  });

  bar.addEventListener('pointerup', finish);
  bar.addEventListener('pointercancel', finish);
  window.addEventListener('pointerup', finish, true);
  bar.addEventListener('click', (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.busy.onGrab?.((value) => {
    document.body.classList.toggle('can-grab', Boolean(value));
  });
}

// Press anywhere on the card and move to drag it. A press that never moves is
// left completely alone, so a click still opens a row's request list, cycles
// the token pill or works a button; a press that moves even a few pixels is a
// drag, and the click it would have produced is swallowed.
const DRAG_THRESHOLD = 4;

function setupCardDrag() {
  const card = $('card');
  if (!card || !window.busy?.dragStart) return;
  let press = null;
  let dragging = false;
  let suppressClick = false;

  const releaseMovers = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', finish, true);
  };

  const finish = () => {
    if (!press && !dragging) return;
    const wasDragging = dragging;
    press = null;
    dragging = false;
    releaseMovers();
    card.classList.remove('is-dragging');
    if (wasDragging) {
      window.busy.dragEnd();
      window.setTimeout(() => { suppressClick = false; }, 420);
    }
  };

  const onMove = (event) => {
    if (!press || dragging) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= DRAG_THRESHOLD) return;
    dragging = true;
    suppressClick = true;
    card.classList.add('is-dragging');
    // Capture only once the press has become a drag: capturing at the start
    // would redirect the click that follows a plain press, and a row's click
    // would never reach it.
    try { card.setPointerCapture(press.id); } catch { /* the release may land outside the window */ }
    window.busy.dragStart();
  };

  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || dragging) return;
    // A new press ends any suppression left over from the previous gesture, so
    // a click that follows a drag (or comes 300ms later) still works.
    suppressClick = false;
    // The top strip keeps its long-press gesture; panes, the menu and the
    // resize corners are not drag surfaces of their own.
    if (event.target.closest('#dragBar, #compactDragBar, .resize-handle, .settings-pane, .about-view, .quick-menu')) return;
    // Listen on the window rather than the card: the press leaves the card as
    // soon as the drag starts, and the threshold has to be crossed before that.
    press = { x: event.clientX, y: event.clientY, id: event.pointerId };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
  });

  card.addEventListener('click', (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

// The card's own close button: it hides the card (the widget's minimise)
// instead of quitting, so the tray icon can bring it back.
function setupCardClose() {
  const button = $('cardClose');
  if (!button || !window.busy?.hideWidget) return;
  button.addEventListener('click', () => window.busy.hideWidget());
}

function setupResizeHandles() {
  const handles = [...document.querySelectorAll('.resize-handle')];
  if (!handles.length || !window.busy?.resizeStart) return;
  let active = null;

  const finish = (event) => {
    if (!active) return;
    const handle = active;
    active = null;
    window.busy.resizeEnd();
    if (event && handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  };

  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      active = handle;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Main-process polling still ends the resize if the release is lost.
      }
      window.busy.resizeStart(handle.dataset.resize || 'se');
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  window.addEventListener('pointerup', finish, true);
  window.busy.onResize?.((value) => {
    document.body.classList.toggle('can-resize', Boolean(value));
  });
}

function setupSettingsPanel() {
  const pane = $('settingsPane');
  if (!pane || !window.busy?.settingsGet) return;
  const form = $('settingsForm');
  const topmost = $('settingsTopmost');
  const mask = $('settingsMask');
  const updateChips = [...document.querySelectorAll('#settingsUpdate .settings-chip')];
  const gateway = $('settingsGateway');
  const periodChips = [...document.querySelectorAll('#settingsPeriods .settings-chip')];
  const metricChips = [...document.querySelectorAll('#settingsMetrics .settings-chip')];
  const fontChips = [...document.querySelectorAll('#settingsFontSizes .settings-chip')];
  const cardChips = [...document.querySelectorAll('#settingsCardSizes .settings-chip')];
  const roll = $('settingsRoll');
  const timing = $('settingsTiming');
  const keepAlive = $('settingsKeepAlive');
  const pathText = $('settingsPath');
  const raw = $('settingsRaw');
  const status = $('settingsStatus');
  const save = $('settingsSave');
  const tabs = [...document.querySelectorAll('[data-settings-page]')];
  let open = false;
  let busy = false;
  let closeTimer = 0;
  let loadGeneration = 0;
  let gatewayReport = '';
  // Only a chip the user actually pressed resizes the window: leaving the chip
  // on today's nearest preset must not snap a hand-dragged window.
  let cardSizeTouched = false;
  // The widths the 卡片大小 chips offer. Main keeps the card's shape, so only the
  // width is sent and the height follows from heightForWidth on that side. The
  // small tier is the smallest window main will keep at that shape (300 wide is
  // only 211 high, under the 216 floor, so it would come back as 308×216): the
  // chip promises the window the user actually gets.
  const CARD_PRESETS = { small: 308, normal: 316, large: 380, xlarge: 460 };

  // Which preset today's window is nearest, so the chip describes a window the
  // user resized by hand instead of claiming a tier it never had.
  const cardPreset = (width) => {
    const current = Number(width) || CARD_PRESETS.normal;
    let best = 'normal';
    let bestDelta = Infinity;
    for (const [name, presetWidth] of Object.entries(CARD_PRESETS)) {
      const delta = Math.abs(current - presetWidth);
      if (delta < bestDelta) {
        best = name;
        bestDelta = delta;
      }
    }
    return best;
  };

  const setStatus = (text, error = false) => {
    status.textContent = text || '';
    status.classList.toggle('error', error);
  };

  const pressChips = (chips, active) => {
    for (const chip of chips) {
      const key = chip.dataset.period || chip.dataset.metric
        || chip.dataset.update || chip.dataset.effect
        || chip.dataset.font || chip.dataset.card;
      chip.setAttribute('aria-pressed', active.has(key) ? 'true' : 'false');
    }
  };

  const selectPage = (tab) => {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !selected;
    }
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectPage(tab));
    tab.addEventListener('keydown', (event) => {
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[index].focus();
      selectPage(tabs[index]);
    });
  }

  for (const chip of periodChips) {
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') === 'true';
      const onCount = periodChips.filter((item) => item.getAttribute('aria-pressed') === 'true').length;
      // One window has to stay on, or the pill has nowhere to roll.
      if (on && onCount <= 1) return;
      chip.setAttribute('aria-pressed', on ? 'false' : 'true');
    });
  }

  for (const chip of metricChips) {
    chip.addEventListener('click', () => {
      for (const other of metricChips) {
        other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
      }
    });
  }

  for (const chip of updateChips) {
    chip.addEventListener('click', () => {
      for (const other of updateChips) {
        other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
      }
    });
  }

  for (const chip of fontChips) {
    chip.addEventListener('click', () => {
      for (const other of fontChips) {
        other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
      }
    });
  }

  for (const chip of cardChips) {
    chip.addEventListener('click', () => {
      cardSizeTouched = true;
      for (const other of cardChips) {
        other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
      }
    });
  }

  const fill = (data) => {
    const s = data.settings || {};
    topmost.checked = Boolean(s.topmost);
    mask.checked = Boolean(s.maskAccounts);
    pressChips(updateChips, new Set([String(s.updateMode || 'idle')]));
    pressChips(periodChips, new Set(
      Array.isArray(s.enabledPeriods) && s.enabledPeriods.length ? s.enabledPeriods : USAGE_PERIODS,
    ));
    pressChips(metricChips, new Set([String(s.pillMetric || 'total')]));
    pressChips(fontChips, new Set([String(s.fontSize || 'normal')]));
    pressChips(cardChips, new Set([cardPreset(s.width)]));
    cardSizeTouched = false;
    roll.checked = s.rollTokens !== false;
    timing.checked = s.showTiming !== false;
    keepAlive.checked = s.keepAlive !== false;
    $('settingsCompact').checked = Boolean(s.compact);
    $('settingsQuiet').checked = Boolean(s.quietMotion);
    gateway.value = s.gateway || '';
    gateway.placeholder = '留空自动检测';
    gatewayReport = `Busy Magpie v${data.version}\n网关：${data.resolvedGateway || '未解析'}\n来源：${data.gatewaySource || '自动检测'}\n路由：${connection.online ? '可读取' : connection.detail}\n用量：${usageStatus.error || (usageData ? '可读取' : '尚未读取')}`;
    $('gatewayResult').textContent = '';
    if (pathText) pathText.textContent = data.path || '';
    if (raw) raw.textContent = data.raw || '';
    if (data.version) $('settingsVersion').textContent = `v${data.version}`;
  };

  const load = async () => {
    const generation = loadGeneration;
    try {
      const data = await window.busy.settingsGet();
      if (!open || generation !== loadGeneration) return;
      fill(data);
      setStatus('');
    } catch (error) {
      if (!open || generation !== loadGeneration) return;
      setStatus(error?.message || '读取设置失败', true);
    }
  };

  const close = () => {
    if (!open) return;
    open = false;
    loadGeneration++;
    document.body.classList.add('settings-closing');
    closeTimer = window.setTimeout(() => {
      pane.hidden = true;
      pane.classList.remove('about');
      $('aboutView').hidden = true;
      document.body.classList.remove('settings-open', 'settings-closing');
    }, 200);
  };

  const show = (data) => {
    window.clearTimeout(closeTimer);
    loadGeneration++;
    open = true;
    document.body.classList.remove('settings-closing');
    pane.hidden = false;
    // Restart the entrance even when it was reopened quickly.
    pane.style.animation = 'none';
    void pane.offsetWidth;
    pane.style.animation = '';
    document.body.classList.add('settings-open');
    const about = data?.mode === 'about';
    pane.dataset.panel = data?.mode || 'settings';
    pane.classList.toggle('about', about);
    $('aboutView').hidden = !about;
    pane.scrollTop = 0;
    if (about) aboutRefresh?.();
    else load();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    save.disabled = true;
    setStatus('保存中…');
    try {
      const cardChip = cardChips.find((chip) => chip.getAttribute('aria-pressed') === 'true')
        || cardChips.find((chip) => chip.dataset.card === 'normal')
        || cardChips[0];
      const result = await window.busy.settingsSave({
        topmost: topmost.checked,
        maskAccounts: mask.checked,
        updateMode: (updateChips.find((chip) => chip.getAttribute('aria-pressed') === 'true')
          || updateChips[0]).dataset.update,
        gateway: gateway.value.trim(),
        usagePeriod: activePeriod(),
        enabledPeriods: periodChips
          .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
          .map((chip) => chip.dataset.period),
        pillMetric: (metricChips.find((chip) => chip.getAttribute('aria-pressed') === 'true')
          || metricChips[0]).dataset.metric,
        rollTokens: roll.checked,
        showTiming: timing.checked,
        keepAlive: keepAlive.checked,
        compact: $('settingsCompact').checked,
        quietMotion: $('settingsQuiet').checked,
        fontSize: (fontChips.find((chip) => chip.getAttribute('aria-pressed') === 'true')
          || fontChips.find((chip) => chip.dataset.font === 'normal')
          || fontChips[0]).dataset.font,
        // Only a touched chip resizes: null leaves the width main has.
        ...(cardSizeTouched ? { width: CARD_PRESETS[cardChip.dataset.card] } : {}),
      });
      if (!result?.ok) {
        setStatus(result?.error || '保存失败', true);
        return;
      }
      fill(result);
      setStatus('已保存');
      window.setTimeout(() => window.busy.settingsClose(), 420);
    } catch (error) {
      setStatus(error?.message || '保存失败', true);
    } finally {
      busy = false;
      save.disabled = false;
    }
  });

  $('settingsClose').addEventListener('click', () => window.busy.settingsClose());
  $('settingsCancel').addEventListener('click', () => window.busy.settingsClose());
  gateway.addEventListener('input', () => { $('gatewayResult').textContent = '当前输入尚未测试'; });
  $('gatewayTest').addEventListener('click', async () => {
    const button = $('gatewayTest'); button.disabled = true;
    $('gatewayResult').textContent = '正在测试路由与用量接口…';
    try {
      const result = await window.busy.testGateway(gateway.value.trim());
      const detail = result.checks.map(check => `${check.name === 'trace' ? '路由' : '用量'}：${check.detail}（${check.ms}ms）`).join('\n');
      gatewayReport = `Busy Magpie ${$('settingsVersion').textContent}\n网关：${result.url || '未解析'}\n来源：${result.source}\n${result.error || detail}`;
      $('gatewayResult').textContent = `${result.ok ? '连接正常' : '连接测试未通过'}\n${result.url || ''}\n${result.error || detail}`;
      $('gatewayResult').classList.toggle('error', !result.ok);
    } catch (error) { $('gatewayResult').textContent = error.message || '测试失败'; }
    finally { button.disabled = false; }
  });
  $('gatewayCopy').addEventListener('click', async () => {
    try {
      const copied = await window.busy.copySummary(redactDiagnostic(gatewayReport, 5000));
      $('gatewayResult').textContent = copied ? '已复制诊断信息，不含账号和凭据。' : '复制失败';
    } catch { $('gatewayResult').textContent = '复制失败'; }
  });
  $('settingsResetPosition').addEventListener('click', async () => {
    const result = await window.busy.resetPlacement();
    setStatus(result.ok ? '已恢复默认位置和大小' : result.error, !result.ok);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      window.busy.settingsClose();
    }
  });

  window.busy.onSettingsPanel((data) => {
    if (data?.open) show(data);
    else close();
  });
}

let aboutRefresh = null;
let renderUpdateState = null;

function setupAbout() {
  const view = $('aboutView');
  if (!view) return;

  const button = el.appVersion;
  const dot = $('updateDot');
  const chip = $('updateChip');
  const chipVersion = $('updateChipVersion');
  const current = $('aboutCurrent');
  const latest = $('aboutLatest');
  const arrow = $('aboutArrow');
  const status = $('aboutStatus');
  const progress = $('updateProgress');
  const progressBar = $('updateProgressBar');
  const update = $('aboutUpdate');
  const check = $('aboutCheck');
  const skip = $('aboutSkip');
  const release = $('aboutRelease');
  $('aboutGitHub').addEventListener('click', () => window.busy.openGitHub());
  const error = $('aboutError');

  const render = (data) => {
    if (!data) return;
    const available = Boolean(data.available && !data.skipped);
    const pct = Math.round((Number(data.progress) || 0) * 100);
    const showLatest = Boolean(data.latest && (available || data.skipped || data.error));
    // Both update channels download and verify before restarting.
    const ready = Boolean(data.ready && available);
    dot.hidden = !available;
    // Keep the one-click update in the same place as the current version.
    const running = Boolean(data.downloading || data.installing);
    const size = downloadSize(data.downloadedBytes, data.totalBytes);
    document.body.classList.toggle('updating', running);
    if (chip) {
      chip.hidden = !available && !running;
      if (!chip.hidden) {
        chipVersion.textContent = data.installing
          ? (data.kind === 'business' ? '切换中' : '安装中')
          : data.downloading ? size.compact : ready ? '' : `v${data.latest || ''}`;
        chip.firstChild.textContent = data.downloading ? '下载 ' : ready ? '重启更新' : '更新 ';
        chip.title = data.downloading ? `${size.text} · ${pct}%` : '';
        chip.disabled = running;
      }
      // The two share one spot: a pending release takes the version's place,
      // so the header never reads both. The tray has 关于 in the meantime.
      if (button) button.hidden = !chip.hidden;
    }
    current.textContent = data.kind === 'shell' && available
      ? `运行环境 v${data.shellVersion || data.current || '—'}`
      : `v${data.current || data.version || '—'}`;
    current.title = data.shellVersion ? `运行环境 v${data.shellVersion}` : '';
    latest.textContent = showLatest ? `v${data.latest}` : '';
    latest.hidden = !showLatest;
    arrow.hidden = !showLatest;
    $('aboutPlugin').textContent = data.pluginVersion ? `v${data.pluginVersion}` : '未提供';

    update.hidden = !available || data.downloading || data.installing;
    update.textContent = ready ? '重启并更新' : `更新到 v${data.latest || ''}`;
    skip.hidden = !available || data.downloading || data.installing;
    check.disabled = Boolean(data.preview || data.checking || data.downloading || data.installing);
    release.hidden = !data.releaseUrl || (!available && !data.error && !data.skipped);

    progress.hidden = !(data.downloading || data.installing);
    progressBar.style.width = `${data.installing ? 100 : pct}%`;
    $('updateBytes').textContent = size.text;
    $('updatePercent').textContent = `${pct}%`;
    $('updateProgressMeta').hidden = !(data.downloading || data.installing || data.ready);

    if (data.preview) {
      status.textContent = '本地预览版使用独立配置，不自动下载或安装更新。';
      error.textContent = '';
    } else if (data.error) {
      status.textContent = data.error;
      error.textContent = '可打开 GitHub Releases 手动安装。';
    } else if (data.downloading) {
      status.textContent = `正在下载 v${data.latest} · ${pct}%`;
      error.textContent = '';
    } else if (data.installing) {
      status.textContent = data.kind === 'business' ? '正在切换版本，应用会重启…' : '正在安装运行环境，应用会重启…';
      error.textContent = '';
    } else if (data.ready && available) {
      status.textContent = `已下载 v${data.latest}，点「重启并更新」完成`;
      error.textContent = '';
    } else if (data.checking) {
      status.textContent = '正在检查更新…';
      error.textContent = '';
    } else if (available) {
      status.textContent = `${data.kind === 'shell' ? '运行环境有更新' : '发现新版本'} v${data.latest}`;
      error.textContent = '';
    } else if (data.skipped) {
      status.textContent = `已跳过 v${data.latest}，可在发布页手动安装。`;
      error.textContent = '';
    } else if (data.latest) {
      status.textContent = '已是最新版本。';
      error.textContent = '';
    } else {
      status.textContent = '还没有检查更新。';
      error.textContent = '';
    }
  };

  renderUpdateState = render;

  aboutRefresh = async () => {
    try {
      render(await window.busy.updatesGet());
    } catch (err) {
      status.textContent = err?.message || '读取版本信息失败';
    }
  };

  // The header is where people ask "is there a newer one?": open 关于 and ask
  // straight away, instead of making them find 检查更新 in the panel.
  button?.addEventListener('click', () => {
    window.busy.aboutOpen();
    window.busy.updatesCheck();
  });
  chip?.addEventListener('click', () => {
    if (!chip.disabled) window.busy.updatesInstall();
  });
  $('aboutClose').addEventListener('click', () => window.busy.settingsClose());
  check.addEventListener('click', () => window.busy.updatesCheck());
  update.addEventListener('click', () => {
    if (window.confirm('更新会重启 Busy Magpie，是否继续？')) {
      window.busy.updatesInstall();
    }
  });
  skip.addEventListener('click', () => window.busy.updatesSkip());
  release.addEventListener('click', () => window.busy.updateOpenRelease());

  window.busy.onUpdateState((data) => render(data));

  window.busy.onAbout(() => {
    const pane = $('settingsPane');
    pane.classList.add('about');
    view.hidden = false;
    aboutRefresh?.();
  });
}

function animateNumber(target, value) {
  if (motionReduced()) {
    const animation = numberAnimations.get(target);
    if (animation) cancelAnimationFrame(animation);
    target.textContent = Number(value).toLocaleString('zh-CN');
    target.dataset.rendered = String(value);
    return;
  }
  const next = Math.max(0, Number(value) || 0);
  if (target.dataset.value === String(next)) return;
  target.dataset.value = String(next);
  const previous = Number(target.dataset.rendered || 0);
  if (previous === next) {
    target.textContent = next.toLocaleString('zh-CN');
    return;
  }

  const start = performance.now();
  const duration = 460;
  const oldAnimation = numberAnimations.get(target);
  if (oldAnimation) cancelAnimationFrame(oldAnimation);

  const tick = (now) => {
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(previous + (next - previous) * eased);
    target.textContent = current.toLocaleString('zh-CN');
    target.dataset.rendered = String(current);
    if (t < 1) numberAnimations.set(target, requestAnimationFrame(tick));
    else {
      target.dataset.rendered = String(next);
      target.textContent = next.toLocaleString('zh-CN');
    }
  };
  numberAnimations.set(target, requestAnimationFrame(tick));
}

function setLiveChrome(view) {
  const waiting = !connection.detail || connection.detail === '正在连接' || connection.detail === '正在重新连接';
  // A card that lost the gateway retries on its own; saying so keeps it from
  // looking like a dead end that needs 重新连接 in the tray.
  const retrying = !connection.online && Boolean(connection.retry);
  const state = connection.online ? 'real' : waiting || retrying ? 'connecting' : 'offline';
  el.live.classList.toggle('active', Boolean(connection.online && view?.inFlight));
  el.live.classList.toggle('connecting', state === 'connecting');
  el.live.classList.toggle('offline', state === 'offline');

  if (state === 'real') {
    el.liveState.textContent = '实时';
  } else if (state === 'connecting') {
    el.liveState.textContent = retrying ? '重连中' : '连接中';
  } else {
    el.liveState.textContent = '未连接';
  }
}

function applyGateway() {
  // The card's header names magpie, not its port: the address lives in the
  // settings panel and in the about pane, where it is asked for.
  if (el.gateway) el.gateway.textContent = settings.gateway || '127.0.0.1:3425';
}


// ── the provider-grouped model list ────────────────────────────────────────
// The card's whole view: one group per serving provider, a grey group head
// (display name + allowance bar) over white rows for each model that
// provider carried. A live request only flips the status — the row keeps the
// numbers of the last request that finished.

// Every provider group is drawn; the list scrolls instead of hiding rows
// behind a "+N more" summary.
let rowsShown = 0;

const routeActive = route => Boolean(route) && (!route.done || (route.tries || []).some(item => !item.done));

function relativeTime(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.round(hours / 24)}d 前`;
}

// What one window of a plan says on the card, shared by the head's line and its
// tooltip so the two never disagree.
function windowText(window) {
  return `${windowLabel(window)} ${Math.round(window.remaining)}%`;
}

function windowTip(window) {
  const bits = [`${windowLabel(window)} 剩余 ${Math.round(window.remaining)}%`,
    `已用 ${window.used.toFixed(1).replace(/\.0$/, '')}%`];
  if (window.amount && window.limit) {
    bits.push(`${Math.round(window.amount).toLocaleString('zh-CN')} / ${Math.round(window.limit).toLocaleString('zh-CN')}${window.unit ? ` ${window.unit}` : ''}`);
  }
  if (window.renewAt && !window.renewAt.startsWith('0001-')) {
    const when = new Date(window.renewAt);
    if (!Number.isNaN(when.getTime())) bits.push(`${when.getMonth() + 1}/${when.getDate()} 续期`);
  }
  return bits.join(' · ');
}

// What the group head's hover says: how much of the window is gone and when it
// renews. "0001-01-01" is magpie's marker for a vendor that never told it. A
// plan's tooltip names every window it is split into, because the bar only
// describes the one it is holding now.
function quotaTip(quota, plan) {
  if (plan && plan.windows.length > 1) {
    return `套餐窗口：${plan.windows.map(windowTip).join(' ｜ ')}`;
  }
  if (!quota) return '';
  const bits = [`已用 ${quota.used.toFixed(1).replace(/\.0$/, '')}%`];
  if (quota.amount && quota.limit) {
    bits.push(`${Math.round(quota.amount).toLocaleString('zh-CN')} / ${Math.round(quota.limit).toLocaleString('zh-CN')}${quota.unit ? ` ${quota.unit}` : ''}`);
  }
  if (quota.renewAt && !quota.renewAt.startsWith('0001-')) {
    const when = new Date(quota.renewAt);
    if (!Number.isNaN(when.getTime())) bits.push(`${when.getMonth() + 1}/${when.getDate()} 续期`);
  }
  return bits.length ? `额度窗口：${bits.join(' · ')}` : '';
}

// The provider's allowance as a horizontal bar on the group head. A bar is
// only drawn when the vendor actually reports the number.
function quotaBarNode(quota, plan) {
  const wrap = create('span', 'provider-quota');
  const remaining = Math.max(0, Math.min(100, quota ? quota.remaining : 0));
  wrap.append(create('span', 'provider-left', `剩余 ${Math.round(remaining)}%`));
  const bar = create('span', 'provider-bar');
  const fill = create('i');
  if (remaining < 20) fill.className = 'low';
  else if (remaining < 50) fill.className = 'mid';
  fill.style.width = `${Math.max(1.5, remaining).toFixed(1)}%`;
  bar.append(fill);
  wrap.append(bar);
  // A plan splits its allowance into time windows: the bar names the one it is
  // holding now, and the line below names the rest.
  if (plan && plan.windows.length > 1) {
    wrap.append(create('span', 'provider-windows', plan.windows.map(windowText).join(' · ')));
  }
  const tip = quotaTip(quota, plan);
  if (tip) wrap.title = tip;
  return wrap;
}

function providerGroupNode(group) {
  const node = create('div', 'provider-group');
  node.dataset.provider = group.key;
  const head = create('div', 'provider-head' + (group.plan ? ' provider-head-plan' : ''));
  head.append(create('b', '', group.provider));
  if (group.quota || group.plan) head.append(quotaBarNode(group.quota, group.plan));
  node.append(head);
  for (const row of group.models) node.append(modelRowNode(row, group));
  return node;
}

// What the row says on hover: the account and how the request got here. The
// provider is already on the group head.
function rowTip(row) {
  const bits = [];
  if (row.account) bits.push(settings.maskAccounts ? mask(row.account) : row.account);
  const when = relativeTime(row.at);
  if (when) bits.push(`最近活动 ${when}`);
  if (row.reroutes > 0) bits.push(`改道 ${row.reroutes} 次`);
  if (row.speed !== null) bits.push(`${Math.round(row.speed)} tok/s`);
  return bits.join(' · ');
}

function modelRowNode(row, group) {
  const node = create('div', `model-row ${row.status}`);
  node.dataset.model = row.model;
  node.dataset.status = row.status;
  // The row is the way into the request detail list: a real button, so both
  // the mouse and the keyboard can ask for it.
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `查看 ${group.provider} 的 ${row.model} 请求明细`);
  const open = () => window.busy.openDetail?.({
    providerKey: group.key, model: row.model, providerName: group.provider,
  });
  node.addEventListener('click', open);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });

  // Two reading tiers. The card is a 500x333 canvas scaled to the window
  // (~0.56 at the default size), so canvas type much below 20px arrives on
  // screen too small to read. The model name carries the row on its own line
  // at 20px with the state word at its right edge, and the measurements sit
  // underneath at 16px where they still read.
  const main = create('span', 'row-main');
  main.append(create('i', `status-dot ${row.status === 'error' ? 'bad' : row.status === 'live' ? 'accent' : 'good'}`));
  main.append(create('b', 'model-name', row.model));
  main.append(create('span', 'state-word', STATE_WORDS[row.status] || '完成'));

  // 耗时拆解 still means what it always did: show the measured timing, or a
  // dash when magpie did not report one. The row prints the ascii duration
  // ("3.0s"): a Chinese unit inside this mono line smears at the card's scale,
  // while the request detail window, unscaled, keeps the Chinese form.
  const timing = settings.showTiming !== false;
  const metrics = create('span', 'row-metrics');
  if (row.reroutes > 0) metrics.append(create('i', 'row-reroute', `改道 ${row.reroutes} 次`));
  metrics.append(
    create('span', 'col-ms mono', timing ? formatDurationShort(row.ms) : '—'),
    create('span', 'col-ttft mono', timing ? formatLatency(row.ttft) : '—'),
    create('span', 'col-speed mono', timing && row.speed !== null ? `${Math.round(row.speed)} tok/s` : '—'),
  );
  node.append(main, metrics);
  const tip = rowTip(row);
  if (tip) node.title = tip;
  return node;
}

function renderProviderGroups(groups, hiddenCount) {
  rowsShown = groups.reduce((n, group) => n + group.models.length, 0);
  el.providerGroups.textContent = '';
  const fragment = document.createDocumentFragment();
  for (const group of groups) fragment.append(providerGroupNode(group));
  el.providerGroups.append(fragment);
  el.modelEmpty.hidden = rowsShown > 0;
  el.modelHidden.hidden = hiddenCount <= 0;
  el.modelHidden.textContent = hiddenCount > 0 ? `+${hiddenCount} 个模型` : '';
  // The rows just changed, so their control rectangles did too.
  requestAnimationFrame(reportHitAreas);
}

function render() {
  const routes = Array.isArray(lastTrace?.routes) ? lastTrace.routes : [];
  const active = routes.filter(routeActive);
  const online = Boolean(connection.online && lastTrace);
  if (online) {
    document.body.classList.remove('stale');
    const { groups, hiddenCount } = providerSessionGroups(routes, { limit: Number.POSITIVE_INFINITY, plans });
    renderProviderGroups(groups, hiddenCount);
  } else {
    // A dropped gateway keeps the last frame on screen and labels it stale
    // rather than blanking a list the user is reading.
    el.modelEmpty.hidden = rowsShown > 0;
    el.modelHidden.hidden = true;
    document.body.classList.toggle('stale', rowsShown > 0);
  }
  setLiveChrome({ inFlight: active.length > 0 });
  $('compactStatus').textContent = online
    ? (active.length ? `${active.length} 个请求进行中` : '已连接 · 空闲')
    : connection.retry ? '自动重连中' : '未连接';
  $('compactLiveDot').classList.toggle('online', online);
}

function setLayout(on) {
  layout = Boolean(on);
  document.body.classList.toggle('layout', layout);
  if (layout) document.activeElement?.blur();
}

function applySettings(next) {
  const previousFont = settings.fontSize;
  settings = { ...settings, ...(next || {}) };
  document.body.classList.toggle('noanim', Boolean(settings.quietMotion));
  applyGateway();
  render();
  if (settings.fontSize !== previousFont) requestAnimationFrame(applyUiScale);
}

async function boot() {
  iconSetup();
  applyGateway();

  const data = await window.busy.bootstrap();
  if (data.version) $('appVersionText').textContent = `v${data.version}${data.preview ? ' 预览' : ''}`;
  if (data.settings) settings = { ...settings, ...data.settings };
  document.body.classList.toggle('noanim', Boolean(settings.quietMotion));
  if (data.connection) connection = data.connection;
  if (data.trace) lastTrace = data.trace;
  if (data.usage) usageData = data.usage;
  if (data.usageStatus) usageStatus = data.usageStatus;
  if (data.quotas) setPlans(data.quotas);
  applyFrame(data.frame);
  applyGateway();
  setLayout(data.layout);
  render();
  renderUsageStatus();

  window.busy.onTrace((trace) => {
    lastTrace = trace;
    connection = { online: true, detail: settings.gateway };
    render();
  });

  window.busy.onQuotas((next) => {
    if (Array.isArray(next?.data)) setPlans(next.data);
    render();
  });

  window.busy.onConnection((status) => {
    connection = status || { online: false, detail: '读取失败' };
    render();
  });

  window.busy.onSettings((next) => applySettings(next));
  window.busy.onLayout((on) => setLayout(on));
  window.busy.onFrame((next) => applyFrame(next));
  window.busy.onUsage((next) => {
    usageData = next;
    applyUsageTokens();
  });
  window.busy.onUsageStatus((next) => {
    usageStatus = next;
    renderUsageStatus();
  });

  new ResizeObserver(() => requestAnimationFrame(applyUiScale)).observe(el.stageArea);
  applyUiScale();

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && layout) window.busy.endLayout();
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  reducedMotion.addEventListener('change', render);
  setupDragBar();
  setupDragBar($('compactDragBar'));
  setupCardDrag();
  setupCardClose();
  setupResizeHandles();
  setupSettingsPanel();
  setupAbout();
  setupTokenPill();
  setupQuickMenu();
  window.busy.ready?.();
  if (data.update) renderUpdateState?.(data.update);
}

boot().catch((error) => {
  connection = { online: false, detail: error?.message || '界面加载失败' };
  render();
});
