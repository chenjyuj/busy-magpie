// The card's provider list: one group for each provider that served a
// request, its allowance, and one row per model that provider carried. A pure
// projection over magpie's trace, so it can be read and tested without a
// window or a clock.
import { speedInfo } from './timing.mjs';

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
const newest = (a, b) => (timestamp(b.time) - timestamp(a.time)) || (numericId(b.id) - numericId(a.id));

// The model a request really landed on: magpie reports it as `served`, and
// while a request is still waiting that field is empty, so the attempt being
// made names it instead.
const servedModel = route => String(route?.served || route?.tries?.at(-1)?.model || '').trim();

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

// The account's own allowance window, as its order entry carries it: "known"
// says the vendor told magpie about a window, "used" is the share of that
// window the model count has consumed. An account without a window (a
// pay-as-you-go key, or a vendor whose quota could not be read) reports
// nothing to show: its "0 used" would read as "100% left", which is a lie.
function quotaOf(seat) {
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

function seatOf(route) {
  const tries = Array.isArray(route.tries) ? route.tries : [];
  const order = Array.isArray(route.order) ? route.order : [];
  const lastTry = tries.length ? tries[tries.length - 1] : null;
  return (lastTry && order.find(item => item.id === lastTry.id)) || order[0] || null;
}

export function providerSessionGroups(routes, { limit = 6 } = {}) {
  const cap = Math.max(0, Number(limit) || 0);
  const sorted = [...(Array.isArray(routes) ? routes : [])].sort(newest);

  const groups = new Map();
  for (const route of sorted) {
    const seat = seatOf(route);
    const key = String(seat?.provider || route.provider || '').trim().toLowerCase() || 'magpie';
    const model = servedModel(route);
    if (!model) continue;

    let group = groups.get(key);
    if (!group) {
      group = { key, provider: '', account: '', quota: null, at: route.time, models: [] };
      groups.set(key, group);
    }
    // The group remembers the provider's most recent seat: its account is
    // what the group header names. Routes arrive newest first, so only the
    // first one seen for a group gets to say.
    if (!group.seen) {
      group.seen = true;
      group.provider = String(seat?.name || '').trim();
      group.account = String(seat?.who || '');
      // The bar describes the account this group names, so it comes from that
      // very seat: a seat that reports no window means nothing is left to
      // show, not that everything is left.
      group.quota = quotaOf(seat);
      group.at = route.time;
    }

    let row = group.models.find(item => item.model === model);
    if (!row) {
      // Routes arrive newest first, so the first one seen for a (provider,
      // model) pair is the freshest: it says what the row is about right now.
      // Older routes only contribute completed metrics below.
      row = {
        model,
        provider: String(seat?.provider || route.provider || ''),
        account: String(seat?.who || ''),
        ms: null, ttft: null, speed: null,
        status: statusOf(route),
        reroutes: rerouteCount(route.tries),
        at: route.time,
        route,
      };
      group.models.push(row);
    }
    // A finished request measures the row — and because routes arrive
    // newest first, the first finished one is the most recent measurement.
    // While a newer request is live the row keeps those numbers.
    if (route.done && !row.metricsSeen) {
      row.metricsSeen = true;
      row.ms = measured(route.ms);
      row.ttft = measured(route.ttft) ?? measured(route.tries?.at(-1)?.ttft);
      const speed = speedInfo(route, route.tries?.at(-1));
      row.speed = speed ? speed.rate : null;
    }
  }

  const ordered = [...groups.values()].map(({ seen, ...group }) => ({
    ...group,
    provider: group.provider || group.key,
    models: group.models
      .map(({ metricsSeen, ...row }) => row)
      .sort((a, b) => timestamp(b.at) - timestamp(a.at)),
  })).sort((a, b) => timestamp(b.at) - timestamp(a.at));

  // The limit caps model rows, not groups: a group stays whole or is left
  // out entirely, so a header never dangles over nothing.
  const kept = [];
  let shown = 0;
  let hidden = 0;
  for (const group of ordered) {
    if (shown + group.models.length <= cap) {
      kept.push(group);
      shown += group.models.length;
    } else {
      hidden += group.models.length;
    }
  }
  return { groups: kept, hiddenCount: hidden };
}