// The request detail list: every request one provider's model served, newest
// first, paged. A pure projection over the same routes the card reads, built
// from the same facts (route-facts.mjs) so the two views can never drift.
//
// A row describes only its own request: a request still in flight reports no
// duration, no first byte and no pace, rather than borrowing the numbers of an
// older one. That is the opposite of the card, which answers "how is this
// model doing right now" and therefore keeps the last completed measurement.
import { speedInfo } from './timing.mjs';
import { newest, servedModel, measured, rerouteCount, statusOf, seatOf, providerKeyOf, clockOf } from './route-facts.mjs';

// A page count or page size the caller mangled still has to mean something.
const wholeAtLeastOne = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
};

export function modelRequests(routes, { providerKey, model, pages = 1, pageSize = 20, providerName = '' } = {}) {
  const key = String(providerKey || '').trim().toLowerCase();
  const wanted = String(model || '').trim();
  const perPage = wholeAtLeastOne(pageSize, 20);
  const pageCount = wholeAtLeastOne(pages, 1);

  const matched = (Array.isArray(routes) ? routes : [])
    .filter(route => route && providerKeyOf(route) === key && servedModel(route) === wanted)
    .sort(newest);

  const rows = matched.slice(0, perPage * pageCount).map(route => ({
    id: route.id,
    at: route.time,
    clock: clockOf(route.time),
    ms: measured(route.ms),
    ttft: measured(route.ttft) ?? measured(route.tries?.at(-1)?.ttft),
    speed: speedInfo(route, route.tries?.at(-1))?.rate ?? null,
    status: statusOf(route),
    reroutes: rerouteCount(route.tries),
  }));

  // The title names the provider the way the card's group header does: the
  // display name the query carried, then the newest seat that served it, and
  // only then the grouping key.
  const named = String(providerName || '').trim()
    || String(seatOf(matched[0] || {})?.name || '').trim()
    || key
    || 'magpie';

  return { rows, total: matched.length, shown: rows.length, hasMore: matched.length > rows.length, providerName: named };
}
