// The card's provider list: one group for each provider that served a
// request, its allowance, and one row per model that provider carried. A pure
// projection over magpie's trace, so it can be read and tested without a
// window or a clock.
import { speedInfo } from './timing.mjs';
import { planForGroup } from './plan-quota.mjs';
import {
  timestamp, newest, servedModel, measured, rerouteCount, statusOf, seatOf, quotaOf, providerKeyOf,
} from './route-facts.mjs';

export function providerSessionGroups(routes, { limit = 6, plans = null } = {}) {
  const cap = Math.max(0, Number(limit) || 0);
  const sorted = [...(Array.isArray(routes) ? routes : [])].sort(newest);

  const groups = new Map();
  for (const route of sorted) {
    const seat = seatOf(route);
    const key = providerKeyOf(route);
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

  // A plan's windows are the vendor's own answer for this account and they come
  // from a second endpoint, so they are attached after the groups are built: a
  // group only knows which account it names once its first seat is read, and
  // the plan has to be the one that account owns.
  if (plans) {
    for (const group of groups.values()) {
      const plan = planForGroup(plans, group.key, group.account);
      if (!plan) continue;
      group.plan = plan;
      // The bar describes the window the plan is holding right now.
      group.quota = plan.primary;
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