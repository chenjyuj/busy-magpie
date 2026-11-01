// The card's words: model names, provider names, masked accounts and the few
// numbers the list formats. Kept pure and free of the page so it stays easy to
// reason about and to test.

export function providerName(name, id) {
  const value = String(name || id || '').trim();
  if (!value) return 'magpie';
  switch (value.toLowerCase()) {
    case 'openai': return 'OpenAI';
    case 'codex': return 'Codex';
    case 'anthropic': return 'Anthropic';
    case 'google': return 'Google';
    case 'gemini': return 'Gemini';
    case 'deepseek': return 'DeepSeek';
    case 'openrouter': return 'OpenRouter';
    case 'xai':
    case 'grok': return 'xAI';
    case 'generic': return 'Provider';
    default: return titleCase(value);
  }
}

export function mask(value) {
  if (!value || !value.trim()) return '—';
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    const tld = dot > 0 ? domain.slice(dot) : '';
    const domainHead = dot > 0 ? domain.slice(0, dot) : domain;
    const localMasked = local.length <= 1 ? '•' : `${local.slice(0, 1)}•••`;
    const domainMasked = domainHead.length <= 1 ? '•••' : `${domainHead.slice(0, 1)}•••`;
    return `${localMasked}@${domainMasked}${tld}`;
  }
  if (/^sk-/i.test(value)) return 'sk-••••••••';
  if (value.includes(' ') || value.includes("'")) return value;
  if (value.length <= 2) return '•••';
  if (value.length <= 5) return `${value.slice(0, 1)}•••`;
  return `${value.slice(0, 2)}•••`;
}

export function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

// The model rows sit on the scaled card, where a Chinese unit inside a mono
// line smears at about seven pixels; those rows print the ascii form the rest
// of the line already uses ("600ms", "100 tok/s"). The request detail window
// is an ordinary window and keeps the Chinese form above.
export function formatDurationShort(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

// A first-byte reading, printed the way the card's row already printed it:
// milliseconds below a second, seconds above it, a dash when magpie reported
// nothing at all.
export function formatLatency(ms) {
  const value = Number(ms) || 0;
  if (!value) return '—';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function titleCase(value) {
  return value
    .replace(/[-_]/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// What a finished, a running and a failed request are called on screen. The
// card's rows and the detail window's rows both read the words from here so
// they can never disagree.
export const STATE_WORDS = { error: '错误', live: '进行中', ok: '完成' };