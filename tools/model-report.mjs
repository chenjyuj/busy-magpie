#!/usr/bin/env node
/**
 * Renders a self-contained, shareable HTML evidence report for the
 * "model session list" work (or any other scenario set that fits the schema).
 *
 *   node tools/model-report.mjs --out <html> --shots <dir> --results <json>
 *
 * Flags (all three are required; `--flag value` and `--flag=value` both work):
 *
 *   --out      <path>  the HTML file to write. A missing parent directory is
 *                      created. The file is always a single document: inline
 *                      CSS, screenshots inlined as base64 `data:` URIs, no
 *                      script, no stylesheet, no font and no other external
 *                      reference of any kind. After writing, the generator
 *                      re-scans its own output for real resource references
 *                      (tags and CSS); a URL quoted inside escaped evidence
 *                      text is text, never a resource, and is not flagged.
 *   --shots    <dir>   directory the scenario `shot` names are relative to
 *                      (an absolute `shot` is used as-is). A missing or
 *                      unreadable picture never fails silently: the report
 *                      shows a visible "截图缺失" placeholder with the reason.
 *   --results  <json>  the evidence to render, in this exact schema:
 *
 *   {
 *     "title":   "报告标题",
 *     "summary": "结论摘要：一段话，渲染在标题下方",
 *     "environment": [ { "k": "字段名", "v": "取值" } ],          // 可选，默认 []
 *     "scenarios": [
 *       {
 *         "id":       "S1",                    // 字符串，用于锚点与标题
 *         "title":    "场景标题",
 *         "steps":    ["步骤 1", "步骤 2"],     // 字符串数组；缺省视为 []
 *         "expected": "预期结果，可含换行",
 *         "actual":   "实际结果，可含换行",
 *         "status":   "pass" | "fail",         // 只认这两个值
 *         "shot":     "s1.png",                // 可选；相对 --shots，缺失即占位
 *         "evidence": "该场景的原始输出"         // 可选；等宽显示、可折行
 *       }
 *     ],
 *     "rawEvidence": [ { "title": "npm test", "text": "原始输出" } ]  // 可选，默认 []
 *   }
 *
 * Anything the schema does not mention is ignored. All rendered text is
 * HTML-escaped, so evidence stays verbatim without becoming markup.
 *
 * Exit codes:
 *   0  report written (and the self-containment scan found nothing)
 *   2  usage error: unknown/missing flag, unreadable results file or shots dir
 *   3  the results JSON is not an object, is malformed, or breaks the schema
 *   4  the report was written but an external resource reference slipped in
 *      (a generator bug; the file is left on disk so it can be inspected)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const USAGE = [
  'usage: node tools/model-report.mjs --out <html> --shots <dir> --results <json>',
  '',
  '  --out      <path>  target single-file HTML report (parent dir is created)',
  '  --shots    <dir>   directory the scenario "shot" names resolve against',
  '  --results  <json>  results JSON, see the schema in this file\'s header',
  '  -h, --help         this text',
  '',
  'exit codes: 0 ok · 2 usage/IO · 3 results schema · 4 external reference found',
].join('\n');

class UsageError extends Error {}

// --- arguments -------------------------------------------------------------

function parseArgs(argv) {
  const args = { help: false };
  const keys = { '--out': 'out', '--shots': 'shots', '--results': 'results' };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    if (flag === '-h' || flag === '--help') {
      args.help = true;
      continue;
    }
    if (!(flag in keys)) throw new UsageError(`unknown argument ${raw}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`);
    args[keys[flag]] = value;
  }
  return args;
}

// --- schema ----------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function checkText(problems, where, value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) problems.push(`${where} 缺少字符串`);
    return;
  }
  if (typeof value !== 'string') problems.push(`${where} 应为字符串，实际是 ${Array.isArray(value) ? 'array' : typeof value}`);
}

function validateResults(data) {
  const problems = [];
  if (!isPlainObject(data)) return ['results 的根节点必须是 JSON 对象'];
  checkText(problems, 'title', data.title);
  checkText(problems, 'summary', data.summary);
  if (data.environment !== undefined && !Array.isArray(data.environment)) problems.push('environment 应为数组，默认 []');
  if (Array.isArray(data.environment)) {
    data.environment.forEach((item, index) => {
      if (!isPlainObject(item)) problems.push(`environment[${index}] 应为 {k, v} 对象`);
      else checkText(problems, `environment[${index}].k`, item.k);
    });
  }
  if (data.rawEvidence !== undefined && !Array.isArray(data.rawEvidence)) problems.push('rawEvidence 应为数组，默认 []');
  if (Array.isArray(data.rawEvidence)) {
    data.rawEvidence.forEach((item, index) => {
      if (!isPlainObject(item)) problems.push(`rawEvidence[${index}] 应为 {title, text} 对象`);
      else checkText(problems, `rawEvidence[${index}].title`, item.title);
    });
  }
  if (!Array.isArray(data.scenarios)) {
    problems.push('scenarios 应为数组');
    return problems;
  }
  if (data.scenarios.length === 0) problems.push('scenarios 不能为空（报告要覆盖至少一个场景）');
  data.scenarios.forEach((scenario, index) => {
    const at = `scenarios[${index}]`;
    if (!isPlainObject(scenario)) {
      problems.push(`${at} 应为对象`);
      return;
    }
    checkText(problems, `${at}.id`, scenario.id);
    checkText(problems, `${at}.title`, scenario.title);
    checkText(problems, `${at}.expected`, scenario.expected);
    checkText(problems, `${at}.actual`, scenario.actual);
    if (scenario.steps === undefined || scenario.steps === null) { /* defaults to [] */ }
    else if (!Array.isArray(scenario.steps)) problems.push(`${at}.steps 应为字符串数组`);
    else scenario.steps.forEach((step, i) => { if (typeof step !== 'string') problems.push(`${at}.steps[${i}] 应为字符串`); });
    if (scenario.status !== 'pass' && scenario.status !== 'fail') problems.push(`${at}.status 应为 'pass' 或 'fail'，实际是 ${JSON.stringify(scenario.status)}`);
    if (scenario.shot !== undefined && scenario.shot !== null && typeof scenario.shot !== 'string') problems.push(`${at}.shot 应为字符串（相对 --shots 的文件名）`);
    if (scenario.evidence !== undefined && scenario.evidence !== null && typeof scenario.evidence !== 'string') problems.push(`${at}.evidence 应为字符串`);
  });
  return problems;
}

// --- screenshots -----------------------------------------------------------

const SIGNATURES = [
  { mime: 'image/png', test: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  { mime: 'image/gif', test: (buffer) => buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { mime: 'image/webp', test: (buffer) => buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP' },
];

function sniffImage(buffer) {
  const hit = SIGNATURES.find((entry) => entry.test(buffer));
  return hit ? hit.mime : null;
}

// Reads are cached so a screenshot is base64-encoded once even though the
// header, the scenario card and the final summary all count it.
const SHOT_CACHE = new Map();

function embedShot(shotsDir, shot) {
  const candidate = path.isAbsolute(shot) ? shot : path.resolve(shotsDir, shot);
  const cached = SHOT_CACHE.get(candidate);
  if (cached) return cached;
  const outcome = readShot(candidate);
  SHOT_CACHE.set(candidate, outcome);
  return outcome;
}

function readShot(candidate) {
  let buffer;
  try {
    if (!existsSync(candidate)) return { ok: false, reason: `文件不存在：${candidate}` };
    if (!statSync(candidate).isFile()) return { ok: false, reason: `不是文件：${candidate}` };
    buffer = readFileSync(candidate);
  } catch (error) {
    return { ok: false, reason: `读取失败：${error.message}` };
  }
  if (buffer.length === 0) return { ok: false, reason: `文件为空：${candidate}` };
  const mime = sniffImage(buffer);
  if (!mime) return { ok: false, reason: `不是可识别的图片（只支持 PNG/JPEG/GIF/WebP）：${candidate}` };
  return { ok: true, mime, base64: buffer.toString('base64'), bytes: buffer.length, file: candidate };
}

// --- rendering -------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// A local ISO stamp with its UTC offset, e.g. 2026-10-31T12:00:00+08:00, so the
// report reads in the reader's timezone instead of a raw UTC instant.
function localStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function block(value) {
  return esc(value).replace(/\r\n?/g, '\n');
}

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0e1014; --panel: #161a21; --panel-2: #1d222b; --line: #2b313d;
  --text: #e7eaf0; --muted: #9aa4b4; --accent: #6cb6ff;
  --pass: #46c05b; --pass-ink: #05210c; --fail: #ff6b60; --fail-ink: #2a0703;
  --warn: #d8a132; --warn-ink: #241a02;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;
  font-size: 15px; line-height: 1.7;
}
code, pre, .mono {
  font-family: "Cascadia Mono", "JetBrains Mono", Consolas, "SFMono-Regular", Menlo, "Courier New", monospace;
}
main { max-width: 1080px; margin: 0 auto; padding: 40px 24px 96px; }
h1 { font-size: 27px; line-height: 1.35; margin: 0 0 10px; }
h2 { font-size: 19px; margin: 44px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
h3 { font-size: 16px; margin: 0 0 12px; }
p { margin: 0 0 12px; }
.hero { border: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--panel); border-radius: 10px; padding: 22px 24px; }
.meta { color: var(--muted); font-size: 13px; margin: 6px 0 14px; }
.verdict { display: inline-flex; align-items: center; gap: 10px; margin: 2px 0 14px; padding: 8px 14px; border-radius: 8px; font-weight: 600; }
.verdict.pass { background: rgba(70, 192, 91, .12); border: 1px solid rgba(70, 192, 91, .38); color: #9bf0ab; }
.verdict.fail { background: rgba(255, 107, 96, .12); border: 1px solid rgba(255, 107, 96, .42); color: #ffb3ad; }
.summary { margin: 0; color: #d3d8e2; }
table { width: 100%; border-collapse: collapse; background: var(--panel); }
caption { text-align: left; color: var(--muted); font-size: 13px; padding-bottom: 8px; }
th, td { border: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
th { background: var(--panel-2); font-weight: 600; white-space: nowrap; }
td.label { width: 104px; color: var(--muted); white-space: nowrap; }
td.k { width: 220px; color: var(--muted); }
ol.steps { margin: 0; padding-left: 22px; }
ol.steps li { margin: 2px 0; }
.badge { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .02em; }
.badge.pass { background: var(--pass); color: var(--pass-ink); }
.badge.fail { background: var(--fail); color: var(--fail-ink); }
.badge.warn { background: var(--warn); color: var(--warn-ink); }
.card { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 18px 20px; margin: 0 0 22px; }
.card > header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.card > header .id { color: var(--muted); font-size: 13px; }
figure { margin: 14px 0 0; }
figure figcaption { color: var(--muted); font-size: 12.5px; margin-top: 6px; }
img.shot { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; background: #000; }
.shot-missing { border: 1px dashed var(--warn); border-radius: 8px; padding: 18px; background: rgba(216, 161, 50, .07); color: #f0d9a4; }
.shot-missing .title { font-weight: 700; margin-bottom: 4px; }
.shot-missing .reason { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
pre { background: #0a0c10; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 12px 0 0;
      white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; overflow-x: auto;
      font-size: 12.5px; line-height: 1.6; color: #cfd6e2; }
pre.caption-title { color: var(--muted); }
.evidence-title { color: var(--muted); font-size: 13px; margin: 16px 0 4px; }
footer { margin-top: 56px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
.muted { color: var(--muted); }
.nav { color: var(--muted); font-size: 13px; margin-top: 12px; }
.nav a { color: var(--accent); text-decoration: none; }
.nav a:hover { text-decoration: underline; }
@media (max-width: 640px) { main { padding: 24px 14px 64px; } td.label, td.k { width: auto; } }
`;

// Rows arrive as [label, already-rendered HTML] pairs.
function renderTable(rows) {
  const body = rows.map((row) => `<tr><th scope="row">${esc(row[0])}</th><td>${row[1]}</td></tr>`).join('\n');
  return `<table><tbody>\n${body}\n</tbody></table>`;
}

function renderScenario(scenario, index, shotsDir) {
  const passed = scenario.status === 'pass';
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const stepsCell = steps.length
    ? `<ol class="steps">${steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>`
    : '<span class="muted">（未填写步骤）</span>';
  const rows = [
    ['测试步骤', stepsCell],
    ['预期', block(scenario.expected).replace(/\n/g, '<br>')],
    ['实际', block(scenario.actual).replace(/\n/g, '<br>')],
    ['结果', `<span class="badge ${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'}</span>`],
  ];
  const parts = [
    `<article class="card" id="scenario-${esc(scenario.id || index + 1)}">`,
    `<header><span class="badge ${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'}</span>`
      + `<h3>${esc(scenario.title)}</h3><span class="id">id ${esc(scenario.id)}</span></header>`,
    renderTable(rows),
  ];
  if (typeof scenario.shot === 'string' && scenario.shot.trim()) {
    const shot = embedShot(shotsDir, scenario.shot.trim());
    if (shot.ok) {
      parts.push(`<figure><img class="shot" alt="${esc(scenario.title)}" src="data:${shot.mime};base64,${shot.base64}">`
        + `<figcaption>截图：${esc(scenario.shot)} · ${esc(shot.mime)} · ${(shot.bytes / 1024).toFixed(1)} KB（内嵌）</figcaption></figure>`);
    } else {
      parts.push('<figure><div class="shot-missing"><div class="title">截图缺失：' + esc(scenario.shot) + '</div>'
        + `<div class="reason">${esc(shot.reason)}</div></div>`
        + `<figcaption>该场景没有可内嵌的截图 —— 报告保留占位，方便补拍后重新生成。</figcaption></figure>`);
    }
  }
  if (typeof scenario.evidence === 'string' && scenario.evidence.trim()) {
    parts.push('<div class="evidence-title">场景原始输出</div>');
    parts.push(`<pre>${block(scenario.evidence)}</pre>`);
  }
  parts.push('</article>');
  return parts.join('\n');
}

function renderReport(data, shotsDir) {
  const scenarios = data.scenarios;
  const passed = scenarios.filter((scenario) => scenario.status === 'pass').length;
  const failed = scenarios.length - passed;
  const verdictClass = failed === 0 ? 'pass' : 'fail';
  const verdictText = failed === 0
    ? `结论：${scenarios.length} 个场景全部通过`
    : `结论：${passed} 通过 / ${failed} 未通过`;
  const environment = Array.isArray(data.environment) ? data.environment : [];
  const rawEvidence = Array.isArray(data.rawEvidence) ? data.rawEvidence : [];

  const envHtml = environment.length
    ? renderTable(environment.map((item) => [item.k, `<span class="mono">${esc(item.v)}</span>`]))
    : '<p class="muted">（未提供 environment）</p>';

  const scenarioHtml = scenarios.map((scenario, index) => renderScenario(scenario, index, shotsDir)).join('\n');
  const rawHtml = rawEvidence.length
    ? rawEvidence.map((item) => `<section><h3>${esc(item.title)}</h3><pre>${block(item.text)}</pre></section>`).join('\n')
    : '<p class="muted">（未提供 rawEvidence）</p>';

  let imageCount = 0;
  let placeholderCount = 0;
  for (const scenario of scenarios) {
    if (typeof scenario.shot === 'string' && scenario.shot.trim()) {
      if (embedShot(shotsDir, scenario.shot.trim()).ok) imageCount += 1;
      else placeholderCount += 1;
    }
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="hero">
<h1>${esc(data.title)}</h1>
<p class="meta">生成时间 ${esc(localStamp())} · 生成器 tools/model-report.mjs · 场景 ${scenarios.length} 个（PASS ${passed} / FAIL ${failed}）· 内嵌截图 ${imageCount} 张${placeholderCount ? ` · 占位 ${placeholderCount} 张` : ''}</p>
<div class="verdict ${verdictClass}">${esc(verdictText)}</div>
<p class="summary">${block(data.summary).replace(/\n/g, '<br>')}</p>
<p class="nav">跳转：<a href="#environment">环境与命令</a> · <a href="#scenarios">场景实测</a> · <a href="#raw">原始证据</a></p>
</header>

<h2 id="environment">环境与命令</h2>
${envHtml}

<h2 id="scenarios">场景实测（测试步骤 / 预期 / 实际 / 结果）</h2>
${scenarioHtml}

<h2 id="raw">原始证据</h2>
${rawHtml}

<footer>
<p>单文件报告：内联 CSS、截图 base64 内嵌，不含脚本、样式表、字体或任何外部资源引用。所有文本按原文转义渲染。</p>
<p>原始证据里出现的地址（例如命令中的网关地址）只是文本，永远不会被浏览器当作资源加载；自检扫描只统计真正的标签与 CSS 引用。</p>
<p>截图 ${imageCount} 张已内嵌${placeholderCount ? `，${placeholderCount} 张缺失并以占位提示标出` : ''}。</p>
</footer>
</main>
</body>
</html>
`;
}

// --- self-containment scan -------------------------------------------------

// Attributes that make a browser fetch something, and the tags that are a
// resource by themselves. Everything rendered as evidence is HTML-escaped
// (`&lt;img …`), so it can never match: this scan looks at real tags only, and
// only inside <style> for CSS, which keeps text that merely *looks* like a
// reference (npm output, a gateway URL in a command) out of the verdict.
const URL_ATTRS = new Set(['src', 'href', 'srcset', 'poster', 'data', 'action', 'formaction', 'background', 'cite', 'longdesc', 'usemap', 'manifest']);
const RESOURCE_TAGS = ['script', 'link', 'iframe', 'object', 'embed', 'base', 'applet', 'frame', 'portal'];
const ATTR_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function externalReferences(html) {
  const found = [];
  for (const tag of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>/g)) {
    const name = tag[1].toLowerCase();
    const attrs = tag[2] ?? '';
    if (RESOURCE_TAGS.includes(name)) found.push(`<${name}> 标签`);
    for (const attr of attrs.matchAll(ATTR_PATTERN)) {
      const attribute = attr[1].toLowerCase();
      const value = (attr[2] ?? attr[3] ?? attr[4] ?? '').trim();
      if (URL_ATTRS.has(attribute) && value && !value.startsWith('data:') && !value.startsWith('#')) {
        found.push(`<${name} ${attribute}="${value.slice(0, 80)}">`);
      }
      if (attribute === 'style') {
        for (const url of value.matchAll(/url\(\s*["']?([^"')]+)/gi)) {
          if (!url[1].trim().startsWith('data:')) found.push(`<${name} style 里的 url(${url[1].trim().slice(0, 60)})`);
        }
      }
    }
  }
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = style[1];
    if (/@import/i.test(css)) found.push('CSS @import');
    for (const url of css.matchAll(/url\(\s*["']?([^"')]+)/gi)) {
      if (!url[1].trim().startsWith('data:')) found.push(`CSS url(${url[1].trim().slice(0, 60)})`);
    }
  }
  return found;
}

// --- main ------------------------------------------------------------------

function fail(message, code) {
  console.error(`model-report: ${message}`);
  if (code === 2) console.error(USAGE);
  process.exitCode = code;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`model-report: ${error.message}`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const missing = ['out', 'shots', 'results'].filter((key) => !args[key]);
  if (missing.length) {
    fail(`缺少必需参数：${missing.map((key) => `--${key}`).join(' ')}`, 2);
    return;
  }

  const resultsPath = path.resolve(args.results);
  if (!existsSync(resultsPath) || !statSync(resultsPath).isFile()) {
    fail(`--results 指向的文件不存在：${resultsPath}`, 2);
    return;
  }
  const shotsDir = path.resolve(args.shots);
  if (!existsSync(shotsDir) || !statSync(shotsDir).isDirectory()) {
    fail(`--shots 指向的目录不存在：${shotsDir}`, 2);
    return;
  }

  let data;
  try {
    // PowerShell's `Set-Content -Encoding UTF8` writes a BOM; JSON.parse does not accept one.
    data = JSON.parse(readFileSync(resultsPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    console.error(`model-report: ${resultsPath} 不是合法 JSON：${error.message}`);
    process.exitCode = 3;
    return;
  }
  const problems = validateResults(data);
  if (problems.length) {
    console.error(`model-report: results 不符合 schema（${resultsPath}）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('schema 见 tools/model-report.mjs 文件头注释。');
    process.exitCode = 3;
    return;
  }

  const outPath = path.resolve(args.out);
  const html = renderReport(data, shotsDir);
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, 'utf8');
  } catch (error) {
    fail(`无法写入 ${outPath}：${error.message}`, 2);
    return;
  }

  const scenarios = data.scenarios;
  const passed = scenarios.filter((scenario) => scenario.status === 'pass').length;
  let embedded = 0;
  let placeholders = 0;
  for (const scenario of scenarios) {
    if (typeof scenario.shot === 'string' && scenario.shot.trim()) {
      if (embedShot(shotsDir, scenario.shot.trim()).ok) embedded += 1;
      else placeholders += 1;
    }
  }

  console.log(`model-report: wrote ${outPath} (${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB)`);
  console.log(`  scenarios : ${scenarios.length} (pass ${passed}, fail ${scenarios.length - passed})`);
  console.log(`  images    : ${embedded} embedded${placeholders ? `, ${placeholders} placeholder (missing or unreadable)` : ''}`);
  const external = externalReferences(html);
  if (external.length) {
    console.error(`  external  : ${external.length} reference(s) found — the report is NOT self-contained:`);
    for (const item of external) console.error(`    - ${item}`);
    process.exitCode = 4;
    return;
  }
  console.log('  external  : 0 references — single-file, self-contained');
}

main(process.argv.slice(2));