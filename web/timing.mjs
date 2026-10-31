// How fast a reply answered, in output tokens a second, shared by every view
// that shows pace. Read the way magpie's own Routing page reads it: the
// reply's output, less its reasoning when the answer started after it, over
// the window from its first streamed token to its end. A reply that came in
// one burst at its end has no speed, and neither has one still streaming:
// magpie counts output only when the reply ends.
export function speedInfo(route, lastTry) {
  if (!route.done) return null;
  const usage = Array.isArray(route.usage) ? route.usage[route.usage.length - 1] : null;
  const out = Number(route.out ?? usage?.out) || 0;
  const think = Number(route.reasoning) || Number(usage?.reasoning) || 0;
  const ms = Number(route.ms) || 0;
  const ttft = Number(route.ttft) || Number(lastTry?.ttft) || 0;
  const firstText = Number(route.firstText) || 0;
  const firstReasoning = Number(route.firstReasoning) || 0;
  const flow = Number(route.flow) || 0;
  if (!out || !ms || !ttft) return null;
  if (route.reasoningHidden && firstText <= 0) return null;
  const visible = think > 0 && firstText <= 0 && firstReasoning >= ttft && flow > 0 && think <= out;
  const tokens = think > 0 && !visible ? out - think : out;
  const from = visible ? firstReasoning : think > 0 ? firstText : ttft;
  const window = ms - from;
  if (!(tokens > 0 && from > 0 && window >= 100 && tokens * 1000 <= 10000 * window)) return null;
  // Held back, then let go: its content came in under a quarter of its window.
  if (flow > 0 && flow * 4 < window) return null;
  // Reasoning that took far longer than the answer it preceded is not a pace.
  if (think > 0 && firstText > 0 && tokens * (firstText - ttft) > 20 * think * window) return null;
  return { rate: (tokens * 1000) / window, tokens, window };
}

// How long the request took to start answering, and where the wait sat.
export function timingInfo(route, lastTry) {
  const net = lastTry && lastTry.net ? lastTry.net : null;
  const ms = Number(route.ms) || 0;
  const ttft = Number(route.ttft) || Number(lastTry?.ttft) || 0;
  if (!ms && !ttft) return null;
  return {
    ms,
    ttft,
    speed: speedInfo(route, lastTry),
    wait: Number(net?.wait) || 0,
    own: Number(net?.own) || 0,
    queued: Number(route.queued) || 0,
  };
}