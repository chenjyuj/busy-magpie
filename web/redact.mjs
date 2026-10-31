// Text the card copies to the clipboard for diagnostics: credentials, keys,
// account names and addresses must not leave the machine.
export function redactDiagnostic(value, limit = 1800) {
  const safe = String(value || '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[Key 已隐藏]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[凭据已隐藏]@');
  return safe.length > limit ? `${safe.slice(0, limit)}\n…（已截断）` : safe;
}