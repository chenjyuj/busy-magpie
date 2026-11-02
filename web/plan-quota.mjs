// magpie's /v1/magpie/quotas answer, read the way the card needs it.
//
// A plan (套餐) splits its allowance into time windows — opencode go is 5
// hours, 7 days and the month — and each window carries its own share of the
// allowance. The card shows every window, because "how much is left" is a
// different question for the window that is running out now and the ones that
// come later. A plan whose windows are unreadable is not a plan the card can
// describe, so it reports nothing instead of inventing a number.

const providerKey = value => String(value || '').trim().toLowerCase();
const timestamp = value => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

// One window, in the shape the card's bar and tooltip already read. magpie
// reports the share used and what is left of it; a vendor that reports only one
// of the two leaves the other to be derived, and an overshoot is clamped rather
// than printed as a negative. A window with neither share is not a window.
export function windowQuota(window) {
  if (!window) return null;
  const remaining = Number(window.remaining);
  const used = Number(window.used);
  const hasRemaining = Number.isFinite(remaining);
  const hasUsed = Number.isFinite(used);
  if (!hasRemaining && !hasUsed) return null;
  const share = hasRemaining ? remaining : 100 - used;
  return {
    name: String(window.name || '').trim(),
    used: Math.max(0, Math.min(100, hasUsed ? used : 100 - share)),
    remaining: Math.max(0, Math.min(100, share)),
    renewAt: String(window.resetsAt || ''),
    amount: Number(window.amount) || 0,
    limit: Number(window.limit) || 0,
    unit: String(window.unit || ''),
    display: String(window.display || ''),
    holdsWhy: String(window.holdsWhy || ''),
  };
}

// The short label a window is printed under. magpie names the time windows in
// English while the card reads a plan in the units it is written in: 5 hours
// becomes 5H, 7 days becomes 7D, the month becomes 本月. A window that is not a
// time window keeps its own name, because shortening it would lose meaning.
export function windowLabel(window) {
  const name = String(window?.name || '').trim();
  const hours = /^(\d+)\s*hours?$/i.exec(name);
  if (hours) return `${hours[1]}H`;
  const days = /^(\d+)\s*days?$/i.exec(name);
  if (days) return `${days[1]}D`;
  if (/^months?$/i.test(name)) return '本月';
  return name;
}

// The window the plan is holding right now. magpie marks which one it is
// ("clock"); a plan that does not say falls back to the one closest to running
// out, because that is the window a single bar has to describe.
export function primaryWindow(windows) {
  const list = (Array.isArray(windows) ? windows : []).filter(Boolean);
  if (!list.length) return null;
  return list.find(window => window.holdsWhy === 'clock')
    || list.slice().sort((a, b) => a.remaining - b.remaining)[0];
}

// One plan per account, as the gateway reports it.
export function planOf(entry) {
  if (!entry || entry.kind !== 'plan') return null;
  const windows = (Array.isArray(entry.windows) ? entry.windows : [])
    .map(windowQuota).filter(Boolean);
  if (!windows.length) return null;
  return {
    provider: String(entry.provider || '').trim(),
    name: String(entry.name || '').trim(),
    user: String(entry.user || '').trim(),
    windows,
    primary: primaryWindow(windows),
    last: entry.last === true,
    lastServedAt: timestamp(entry.lastServedAt),
  };
}

// The plan a group's account belongs to. One provider can serve with several
// accounts and each account has its own plan, so the account picks its own
// entry: the user it names, then the one magpie marked as last served, then
// the first one.
export function planForGroup(byProvider, provider, user) {
  const list = byProvider.get(providerKey(provider));
  if (!list || !list.length) return null;
  const wanted = String(user || '').trim();
  if (wanted) {
    const match = list.find(plan => plan.user && plan.user === wanted);
    if (match) return match;
  }
  return list.find(plan => plan.last) || list[0];
}

// One list of plans per provider key, from the gateway's whole answer.
export function plansByProvider(entries) {
  const byProvider = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const plan = planOf(entry);
    if (!plan) continue;
    const key = providerKey(plan.provider);
    if (!key) continue;
    const list = byProvider.get(key) || [];
    list.push(plan);
    byProvider.set(key, list);
  }
  return byProvider;
}
