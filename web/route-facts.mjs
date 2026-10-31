// The facts one magpie route reports, shared by every view that reads it: the
// card's provider list and the request detail list. Pure functions, so they
// can be read and tested without a window or a clock.

const timestamp = value => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};
const numericId = value => {
  const id = Number(value);
  return Number.isFinite(id) ? id : 0;
};
// Newest first, with the id deciding a tie so the order never depends on the
// array order magpie happened to answer with.
export const newest = (a, b) => (timestamp(b.time) - timestamp(a.time)) || (numericId(b.id) - numericId(a.id));

// The model a request really landed on: magpie reports it as `served`, and
// while a request is still waiting that field is empty, so the attempt being
// made names it instead.
export const servedModel = route => String(route?.served || route?.tries?.at(-1)?.model || '').trim();

// A metric the card may show, or null when magpie did not report one. Zero is
// never a measurement here: the card prints a dash instead of inventing one.
export const measured = value => {
  const number = Number(value) || 0;
  return number > 0 ? number : null;
};

export function rerouteCount(tries) {
  const models = new Set((Array.isArray(tries) ? tries : [])
    .map(item => String(item?.model || '').trim())
    .filter(Boolean));
  return Math.max(0, models.size - 1);
}

// A failure outranks work in progress; a finished request with no error is ok.
export function statusOf(route) {
  if (route.error || Number(route.status) >= 400) return 'error';
  if (!route.done) return 'live';
  return 'ok';
}

// The account's own allowance window, as its order entry carries it: "known"
// says the vendor told magpie about a window, "used" is the share of that
// window the model count has consumed. An account without a window (a
// pay-as-you-go key, or a vendor whose quota could not be read) reports
// nothing to show: its "0 used" would read as "100% left", which is a lie.
export function quotaOf(seat) {
  if (!seat || seat.known !== true) return null;
  const used = Number(seat.used);
  if (!Number.isFinite(used)) return null;
  const limit = Number(seat.limit) || 0;
  if (limit <= 0) return null;
  const renews = Array.isArray(seat.renews) ? seat.renews : [];
  return {
    used: Math.max(0, Math.min(100, used)),
    remaining: Math.max(0, Math.min(100, 100 - used)),
    renewAt: seat.usedRenews || renews[0] || '',
    amount: Number(seat.amount) || 0,
    limit,
    unit: String(seat.unit || ''),
  };
}

export function seatOf(route) {
  const tries = Array.isArray(route.tries) ? route.tries : [];
  const order = Array.isArray(route.order) ? route.order : [];
  const lastTry = tries.length ? tries[tries.length - 1] : null;
  return (lastTry && order.find(item => item.id === lastTry.id)) || order[0] || null;
}

// The key a provider is grouped by: the seat that carried the request says it,
// the route itself is the fallback, and a request that named nobody belongs to
// magpie.
export const providerKeyOf = route =>
  String(seatOf(route || {})?.provider || route?.provider || '').trim().toLowerCase() || 'magpie';

// The wall clock a request happened at, in the local time zone. Hand-rolled so
// the same route formats the same way on every machine, and a time magpie
// mangled shows as nothing rather than "NaN:NaN:NaN".
export function clockOf(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const at = new Date(ms);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export { timestamp, numericId };
