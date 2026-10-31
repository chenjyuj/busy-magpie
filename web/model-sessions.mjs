// The card's per-model list: one row for each model that actually served a
// request, carrying that model's most recent request. A pure projection over
// magpie's trace, so it can be read and tested without a window or a clock.
import { speedInfo } from './timing.mjs';

const timestamp = value => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};
const numericId = value => {
  const id = Number(value);
  return Number.isFinite(id) ? id : 0;
};

// The model a request really landed on: magpie reports it as `served`, and
// while a request is still waiting that field is empty, so the attempt being
// made names it instead.
export function servedModel(route) {
  return String(route?.served || route?.tries?.at(-1)?.model || '').trim();
}

// A metric the card may show, or null when magpie did not report one. Zero is
// never a measurement here: the card prints a dash instead of inventing one.
const measured = value => {
  const number = Number(value) || 0;
  return number > 0 ? number : null;
};

function rerouteCount(tries) {
  const models = new Set((Array.isArray(tries) ? tries : [])
    .map(item => String(item?.model || '').trim())
    .filter(Boolean));
  return Math.max(0, models.size - 1);
}

// A failure outranks work in progress; a finished request with no error is ok.
function statusOf(route) {
  if (route.error || Number(route.status) >= 400) return 'error';
  if (!route.done) return 'live';
  return 'ok';
}

function toRow(model, route) {
  const tries = Array.isArray(route.tries) ? route.tries : [];
  const lastTry = tries.length ? tries[tries.length - 1] : null;
  const order = Array.isArray(route.order) ? route.order : [];
  const seat = (lastTry && order.find(item => item.id === lastTry.id)) || order[0] || null;
  const speed = speedInfo(route, lastTry);
  return {
    key: model,
    model,
    provider: String(seat?.provider || route.provider || ''),
    account: String(seat?.who || lastTry?.id || ''),
    ms: measured(route.ms),
    ttft: measured(route.ttft) ?? measured(lastTry?.ttft),
    out: measured(route.out),
    speed: speed ? speed.rate : null,
    status: statusOf(route),
    reroutes: rerouteCount(tries),
    at: route.time,
    route,
  };
}

export function modelSessionRows(routes, { limit = 6 } = {}) {
  const cap = Math.max(0, Number(limit) || 0);
  const sorted = [...(Array.isArray(routes) ? routes : [])].sort((a, b) => (
    (timestamp(b.time) - timestamp(a.time)) || (numericId(b.id) - numericId(a.id))
  ));
  const rows = [];
  const seen = new Set();
  for (const route of sorted) {
    const model = servedModel(route);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    rows.push(toRow(model, route));
  }
  return { rows: rows.slice(0, cap), hiddenCount: Math.max(0, rows.length - cap) };
}