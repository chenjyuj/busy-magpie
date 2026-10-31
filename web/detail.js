// The detail window: every request one provider's model served, newest first.
// It holds no gateway connection of its own — main pushes the merged route
// table and this page only projects it, so the two views never disagree.
import { formatDuration, formatLatency, STATE_WORDS } from './presenter.js';
import { modelRequests } from './requests.mjs';

const PAGE_SIZE = 20;

const el = {
  title: document.getElementById('detailTitle'),
  rows: document.getElementById('detailRows'),
  empty: document.getElementById('detailEmpty'),
  more: document.getElementById('detailMore'),
  close: document.getElementById('detailClose'),
};

// How many pages of 20 the user has asked for. Live updates reuse the same
// count, so a new request slides in at the top instead of resetting the list.
let pages = 1;
let current = { query: null, routes: [] };

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stateNode(status) {
  const state = create('span', 'col-state');
  const tone = status === 'error' ? 'bad' : status === 'live' ? 'accent' : 'good';
  state.append(create('i', `status-dot ${tone}`));
  state.append(create('span', 'state-word', STATE_WORDS[status] || STATE_WORDS.ok));
  return state;
}

// One row is one request: a request still in flight shows its own gaps rather
// than borrowing the numbers of the last one that finished.
function rowNode(row) {
  const node = create('div', `detail-row ${row.status}`);
  node.dataset.id = String(row.id);
  node.dataset.status = row.status;
  node.append(
    create('span', 'col-clock mono', row.clock || '—'),
    create('span', 'col-ms mono', formatDuration(row.ms)),
    create('span', 'col-ttft mono', formatLatency(row.ttft)),
    create('span', 'col-speed mono', row.speed === null ? '—' : `${Math.round(row.speed)} tok/s`),
    stateNode(row.status),
  );
  return node;
}

function render() {
  const { query, routes } = current;
  if (!query) return;
  const { rows, hasMore, providerName } = modelRequests(routes, {
    providerKey: query.providerKey,
    model: query.model,
    pages,
    pageSize: PAGE_SIZE,
    providerName: query.providerName,
  });
  el.title.textContent = `${providerName} · ${query.model}`;
  el.rows.textContent = '';
  const fragment = document.createDocumentFragment();
  for (const row of rows) fragment.append(rowNode(row));
  el.rows.append(fragment);
  el.empty.hidden = rows.length > 0;
  el.more.hidden = !hasMore;
}

function accept(payload) {
  const query = payload && payload.query;
  if (!query || !query.providerKey || !query.model) return;
  const sameModel = current.query
    && current.query.providerKey === query.providerKey
    && current.query.model === query.model;
  // Another model means another list: back to its first page.
  if (!sameModel) pages = 1;
  current = { query, routes: Array.isArray(payload.routes) ? payload.routes : [] };
  render();
}

el.more.addEventListener('click', () => { pages += 1; render(); });
el.close.addEventListener('click', () => window.busy.closeDetail());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.busy.closeDetail();
});

window.busy.onDetail(accept);
window.busy.detailReady();
