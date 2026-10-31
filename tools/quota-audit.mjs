// Ask the real gateway what the card would draw right now, using the very
// module the renderer uses. Run: node tools/quota-audit.mjs
import { providerSessionGroups } from '../web/model-sessions.mjs';

const gateway = process.env.BUSY_MAGPIE_GATEWAY || 'http://127.0.0.1:3425';
const res = await fetch(`${gateway}/v1/magpie/trace?after=0`, { signal: AbortSignal.timeout(8000) });
const trace = await res.json();
const { groups, hiddenCount } = providerSessionGroups(trace.routes || [], { limit: 6 });

const pad = (text, width) => String(text).padEnd(width);
console.log(`schema ok · routes=${(trace.routes || []).length} · groups=${groups.length} · hidden=${hiddenCount}\n`);
console.log(pad('组头显示名', 18), pad('组键', 18), pad('剩余', 12), pad('已用/窗口', 22), '条');
console.log('-'.repeat(84));
for (const group of groups) {
  const q = group.quota;
  const bar = q ? (q.remaining >= 50 ? '绿' : q.remaining >= 20 ? '橙' : '红') : '不画条';
  console.log(
    pad(group.provider, 18),
    pad(group.key, 18),
    pad(q ? `剩余 ${q.remaining.toFixed(2)}%` : '—', 12),
    pad(q ? `${q.amount} / ${q.limit} ${q.unit}` : '(无额度窗口)', 22),
    bar,
  );
}

// The account each group names, plus every seat's raw fields, so a mismatch
// between "what magpie says" and "what the vendor says" is visible.
console.log('\n各供应商最新 seat 的原始字段：');
const seen = new Set();
for (const route of trace.routes || []) {
  for (const seat of route.order || []) {
    if (seat.kind !== 'account' || seen.has(seat.provider)) continue;
    seen.add(seat.provider);
    const hasWindow = Number(seat.limit) > 0;
    console.log(
      `  ${pad(seat.provider, 18)} known=${pad(seat.known, 6)} used=${pad(seat.used, 8)}`,
      `limit=${pad(seat.limit, 8)} unit=${pad(seat.unit, 8)} → ${hasWindow ? '画条' : '不画条'}`,
    );
  }
}
