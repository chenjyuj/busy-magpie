"""Deterministic stand-in for magpie's trace + usage endpoints.

It exists for the "model session list" view (``web/model-sessions.mjs``): every
route carries the fields that view reads, and every scenario is fixed, so a
browser session or a screenshot can be checked against exact numbers instead of
"looks about right".

Usage::

    python tools/mock_models.py <port> <scenario>
    python tools/mock_models.py            # port 3500, scenario ok
    python tools/mock_models.py 3500 many

    <port>      default 3500
    <scenario>  ok | error | live | missing | many | flaky   (default ok)

Then point the widget at it::

    $env:BUSY_MAGPIE_GATEWAY = 'http://127.0.0.1:3500'
    npx electron . --preview --remote-debugging-port=9223

Endpoints
---------

``GET /v1/magpie/trace?after=<seq>&wait=1``::

    {object, now, seq, pid, serves, totals:{requests,rerouted,errors}, routes:[...]}

``GET /v1/magpie/usage?period=<today|7d|30d|all>``::

    {period, calls, errors, retried, input, output, cache_read, cache_write}

``GET /`` is an alias of the trace endpoint, handy for a quick ``curl``/``Invoke-WebRequest``.

Every route carries (per the design spec §3 field list, trimmed to the fields
the list view reads)::

    id      numeric, unique per route (the widget merges by String(id))
    time    ISO-8601 with offset, frozen at startup (see "Determinism")
    agent   'codex' | 'claude' | 'dsh' | 'cursor' | 'kimi' | 'gemini'
    model   the *requested* model, e.g. 'officeace/deepseek-v4.1-flash'
    served  the model that actually answered — what the list groups by
    provider 'officeace' | 'workbuddy' | 'anthropic' | ...
    conv    conversation id (there is no 'session' field in magpie)
    done    bool; a route with done=false is "进行中"
    status  200, or 500 on a failed route
    ms      request duration in ms (absent while in flight)
    ttft    time to first byte in ms (absent when magpie never reported it)
    out     output tokens (absent when magpie never reported it)
    error   present only on a failed route, e.g. '上游返回 500：...'
    flow, firstText   streaming hints used by the tok/s reading
    tries   [{id, model, done, status, ms, ttft}] the attempts in order
    order   [{id, name, kind:'account', who, model, provider}] the accounts
            that served those attempts, keyed by the same id as the try

Scenarios (all deterministic — no RNG anywhere)
-----------------------------------------------

``ok``      4 routes over 3 different ``served`` models, all done/200.
            ``glm-5.3`` is served twice, by ``officeace`` (60 s ago) and
            ``workbuddy`` (5 s ago), to prove grouping is by model name only:
            the newest one wins the row and shows provider ``workbuddy``.
            Rows (newest first): ``glm-5.3``, ``claude-sonnet-4-5``,
            ``deepseek-v4.1-flash``; hiddenCount 0.
``error``   3 rows: ``glm-5.3`` failed with status 500 + ``error`` text (row
            status «错误»); ``deepseek-v4.1-flash`` reached that model after a
            failed first try (``tries`` holds two models → «改道 1 次», yet the
            route itself is done/200, so it stays «完成»); ``claude-sonnet-4-5``
            plain success.
``live``    3 rows; the newest (``glm-5.3``) is ``done:false`` with no ``ms``/
            ``out`` → «进行中», 时长 `—`, 首字 `900ms`, tok/s `—`. It never
            completes, so the live state is stable for screenshots.
``missing`` 3 rows; the newest (``glm-5.3``) has ``ms=4200`` but no ``ttft``
            and no ``out`` → 时长 shown, 首字 `—`, tok/s `—` (the `—` path).
``many``    7 routes, 7 distinct ``served`` models → 6 rows + the
            「+1 个模型」 summary row (hiddenCount 1).
``flaky``   starts exactly like ``ok``, then every trace request from the Nth
            on answers HTTP 500 (default ``MOCK_FLAKY_AFTER=3``) or drops the
            connection (``MOCK_FLAKY_MODE=close``). The widget must keep the
            last frame and mark it 「暂未刷新」.

Metrics are picked so the tok/s reading (``timing.speedInfo``: output over
``ms - ttft``) lands on exactly **100 tok/s** for every completed route that
has output: 240/(3000-600), 200/(2500-500), 340/(4200-800), 208/(2600-520),
400/(5000-1000), 272/(3400-680), 304/(3800-760). Durations are 3.0/2.5/4.2/…
seconds and first bytes 600/500/800/… ms. Exact rendered wording («3.0 秒»,
«600ms», …) is up to ``web/`` — this file only fixes the raw numbers.

Determinism
-----------

* Route times are stamped once, at startup: ``time = 启动时刻 - offset``. They
  never move, so "which request is the newest" is decided by the frozen offsets
  and a verifier can assert absolute ISO times. ``now`` is the live clock.
* ``pid`` is fixed (``MOCK_PID``, default 4242). Change it between runs to
  exercise the widget's "magpie restarted → clear the table" path.
* ``seq`` is the 1-based trace-request counter. Like magpie, the first read
  (``after=0``) answers at once and a later ``wait=1`` holds for
  ``MOCK_WAIT_MS`` (default 200 ms) before answering the same snapshot.
* ``totals`` is derived from the routes, not invented:
  ``requests = len(routes)``, ``rerouted = routes with >1 distinct try model``,
  ``errors = routes whose own outcome is an error``.

Environment knobs
-----------------

``MOCK_PID``           pid reported by the trace endpoint (default 4242)
``MOCK_WAIT_MS``       long-poll hold in ms (default 200)
``MOCK_FLAKY_AFTER``   1-based trace request index at which ``flaky`` breaks
                       (default 3)
``MOCK_FLAKY_MODE``    ``http500`` (default) or ``close``
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# Route times hang off this instant, so every run of a scenario is identical.
BASE = datetime.now().astimezone()

SCENARIOS = ("ok", "error", "live", "missing", "many", "one", "quota", "flaky", "empty")

USAGE_PERIODS = ("today", "7d", "30d", "all")

# Fixed per-window usage numbers: the pill cycles today -> 7d -> 30d -> all, and
# these stay the same across requests so a screenshot can be re-checked.
USAGE = {
    "today": {"calls": 132, "errors": 1, "retried": 3, "input": 812_000, "output": 96_000, "cache_read": 4_200_000, "cache_write": 18_000},
    "7d": {"calls": 928, "errors": 3, "retried": 11, "input": 4_860_000, "output": 612_000, "cache_read": 28_400_000, "cache_write": 96_000},
    "30d": {"calls": 3_412, "errors": 9, "retried": 47, "input": 18_240_000, "output": 2_180_000, "cache_read": 118_600_000, "cache_write": 402_000},
    "all": {"calls": 12_884, "errors": 31, "retried": 163, "input": 71_500_000, "output": 8_940_000, "cache_read": 520_300_000, "cache_write": 1_240_000},
}

PROVIDER_NAMES = {
    "officeace": "OfficeAce",
    "workbuddy": "WorkBuddy",
    "anthropic": "Anthropic",
    "openrouter": "OpenRouter",
    "openai": "OpenAI",
    "moonshot": "Moonshot",
    "google": "Google",
    "codearts": "CodeArts",
    "trae-cn": "Trae CN",
}

# Fixed allowance per provider so a screenshot can be re-checked: officeace
# leaves 89% (green), codearts 40% (amber), trae-cn 15% (red). Providers not
# listed report no allowance at all, which the card draws as no bar.
QUOTAS = {
    "officeace": {"used": 11, "amount": 5_755, "limit": 9_600, "unit": "credits"},
    "workbuddy": {"used": 0, "amount": 331, "limit": 3_400, "unit": "credits"},
    "codearts": {"used": 60, "amount": 5_760, "limit": 9_600, "unit": "credits"},
    "trae-cn": {"used": 85, "amount": 5_015, "limit": 5_900, "unit": "credits"},
}

SCENARIO_NOTES = {
    "ok": "4 routes / 3 served models, all done/200 (glm-5.3 served by two providers -> one row)",
    "error": "3 rows: one status 500 + error, one rerouted to another model, one plain success",
    "live": "3 rows: newest is done=false (no ms/out) -> 进行中 + 首字 900ms",
    "missing": "3 rows: newest has ms but no ttft/out -> 时长 shown, 首字 —, tok/s —",
    "many": "7 served models -> 6 rows + 「+1 个模型」 summary row",
    "one": "one provider with one model: the smallest useful card",
    "quota": "3 providers with 89% / 40% / 15% left -> green, amber and red allowance bars",
    "flaky": "ok at first, then HTTP 500 / dropped connection from the Nth trace request",
    "empty": "a live gateway that has answered nothing yet: no routes -> 等待 magpie 数据",
}

REQUESTS = {"trace": 0}


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"mock_models: {name}={raw!r} is not an integer", file=sys.stderr)
        raise SystemExit(2)


PID = env_int("MOCK_PID", 4242)
WAIT_MS = env_int("MOCK_WAIT_MS", 200)
FLAKY_AFTER = max(1, env_int("MOCK_FLAKY_AFTER", 3))
FLAKY_MODE = os.environ.get("MOCK_FLAKY_MODE", "http500").strip().lower() or "http500"


def stamp(offset_seconds: float = 0.0) -> str:
    """ISO-8601 local time, ``offset_seconds`` before the frozen start instant."""
    return (BASE - timedelta(seconds=offset_seconds)).isoformat(timespec="seconds")


def account_id(provider: str, who: str) -> str:
    """The id shared by a try and its order entry."""
    if not who:
        return provider
    return f"{provider}:{who.split('@')[0]}"


def attempt(provider: str, who: str, model: str, *, done: bool = True,
            status: int | None = 200, ms: int | None = None,
            ttft: int | None = None) -> tuple[dict, dict]:
    """One try plus the account entry that served it (same ``id``)."""
    try_item: dict = {"id": account_id(provider, who), "model": model, "done": done}
    if status is not None:
        try_item["status"] = status
    if ms is not None:
        try_item["ms"] = ms
    if ttft is not None:
        try_item["ttft"] = ttft
    order_item = {
        "id": account_id(provider, who),
        "name": PROVIDER_NAMES.get(provider, provider),
        "kind": "account",
        "who": who,
        "model": model,
        "provider": provider,
    }
    quota = QUOTAS.get(provider)
    if quota:
        order_item.update({
            "known": True,
            "used": quota["used"],
            "amount": quota["amount"],
            "limit": quota["limit"],
            "unit": quota["unit"],
            "renews": ["2026-11-19T16:00:00Z"],
            "usedRenews": "2026-11-19T16:00:00Z",
        })
    return try_item, order_item


def make_route(route_id: int, offset: float, *, agent: str, requested: str,
               served: str, provider: str, who: str, conv: str,
               attempts: list[tuple[dict, dict]] | None = None, done: bool = True,
               status: int | None = 200, ms: int | None = None,
               ttft: int | None = None, out: int | None = None,
               error: str | None = None) -> dict:
    """A complete route as magpie's trace would report it."""
    if attempts is None:
        attempts = [attempt(provider, who, served, done=done, status=status, ms=ms, ttft=ttft)]
    tries = [item for item, _ in attempts]
    order = [entry for _, entry in attempts]
    route: dict = {
        "id": route_id,
        "time": stamp(offset),
        "agent": agent,
        "model": requested,
        "served": served,
        "provider": provider,
        "conv": conv,
        "done": done,
        "tries": tries,
        "order": order,
    }
    if status is not None:
        route["status"] = status
    if ms is not None:
        route["ms"] = ms
    if ttft is not None:
        route["ttft"] = ttft
        # The stream's first visible token; the tok/s reading measures from ttft
        # (no reasoning here), so this only keeps the payload realistic.
        route["firstText"] = ttft
    if out is not None:
        route["out"] = out
    if done and out and ms is not None and ttft is not None:
        # The streaming window the pace is read over: from the first visible
        # token to the end of the reply, which is what speedInfo divides the
        # output by. A literal small value here reads as "arrived in one burst"
        # and correctly yields no pace at all.
        route["flow"] = max(1, ms - ttft)
    if error is not None:
        route["error"] = error
    return route


# --- scenarios -------------------------------------------------------------

def scenario_ok() -> list[dict]:
    """3 served models, 4 routes: glm-5.3 answered by two different providers."""
    conv = "01a1546e-3108-7473"
    return [
        make_route(1792464002001, 60, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="glm-5.3", provider="officeace", who="alex@example.com", conv=conv,
                   ms=3000, ttft=600, out=240),
        make_route(1792464002002, 45, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="deepseek-v4.1-flash", provider="officeace", who="alex@example.com", conv=conv,
                   ms=2500, ttft=500, out=200),
        make_route(1792464002003, 20, agent="claude", requested="anthropic/claude-sonnet-4-5",
                   served="claude-sonnet-4-5", provider="anthropic", who="sam@example.com",
                   conv="01a1546e-3108-7474", ms=4200, ttft=800, out=340),
        make_route(1792464002004, 5, agent="dsh", requested="workbuddy/glm-5.3",
                   served="glm-5.3", provider="workbuddy", who="lee@example.com",
                   conv="01a1546e-3108-7475", ms=3000, ttft=600, out=240),
    ]


def scenario_error() -> list[dict]:
    """One failed route, one rerouted route that still succeeded, one success."""
    first = attempt("officeace", "alex@example.com", "glm-5.3", done=True, status=500, ms=1800, ttft=700)
    second = attempt("officeace", "alex@example.com", "deepseek-v4.1-flash", done=True, status=200, ms=2500, ttft=500)
    return [
        make_route(1792464002101, 90, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="glm-5.3", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-7481", status=500, ms=1800, ttft=700,
                   error="上游返回 500：upstream_error（mock 场景 error）"),
        make_route(1792464002102, 30, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="deepseek-v4.1-flash", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-7482", attempts=[first, second],
                   ms=2500, ttft=500, out=200),
        make_route(1792464002103, 10, agent="claude", requested="anthropic/claude-sonnet-4-5",
                   served="claude-sonnet-4-5", provider="anthropic", who="sam@example.com",
                   conv="01a1546e-3108-7483", ms=4200, ttft=800, out=340),
    ]


def scenario_live() -> list[dict]:
    """The newest route is still streaming: no ms, no out, alive forever.

    An earlier completed request for the same model proves the card keeps its
    measurements while the new one runs.
    """
    live = attempt("officeace", "alex@example.com", "glm-5.3", done=False, status=None, ms=None, ttft=900)
    return [
        make_route(1792464002201, 15, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="glm-5.3", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-7491", attempts=[live], done=False, status=None,
                   ms=None, ttft=900),
        make_route(1792464002204, 45, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="glm-5.3", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-7494", ms=3000, ttft=600, out=240),
        make_route(1792464002202, 40, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="deepseek-v4.1-flash", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-7492", ms=2500, ttft=500, out=200),
        make_route(1792464002203, 70, agent="claude", requested="anthropic/claude-sonnet-4-5",
                   served="claude-sonnet-4-5", provider="anthropic", who="sam@example.com",
                   conv="01a1546e-3108-7493", ms=4200, ttft=800, out=340),
    ]


def scenario_missing() -> list[dict]:
    """The newest route has a duration but no ttft and no out."""
    return [
        make_route(1792464002301, 25, agent="dsh", requested="workbuddy/glm-5.3",
                   served="glm-5.3", provider="workbuddy", who="lee@example.com",
                   conv="01a1546e-3108-7501", ms=4200, ttft=None, out=None),
        make_route(1792464002302, 55, agent="codex", requested="officeace/deepseek-v4.1-flash",
                   served="deepseek-v4.1-flash", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-7502", ms=2500, ttft=500, out=200),
        make_route(1792464002303, 85, agent="claude", requested="anthropic/claude-sonnet-4-5",
                   served="claude-sonnet-4-5", provider="anthropic", who="sam@example.com",
                   conv="01a1546e-3108-7503", ms=4200, ttft=800, out=340),
    ]


MANY_MODELS = [
    ("glm-5.3", "officeace", "alex@example.com", "codex", 3000, 600, 240),
    ("deepseek-v4.1-flash", "officeace", "alex@example.com", "codex", 2500, 500, 200),
    ("claude-sonnet-4-5", "anthropic", "sam@example.com", "claude", 4200, 800, 340),
    ("qwen3-coder", "openrouter", "key-9f2c", "cursor", 2600, 520, 208),
    ("gpt-6-astra", "openai", "jonny@example.com", "codex", 5000, 1000, 400),
    ("kimi-k2.5", "moonshot", "kai@example.com", "kimi", 3400, 680, 272),
    ("gemini-3-pro", "google", "rin@example.com", "gemini", 3800, 760, 304),
]


def scenario_many() -> list[dict]:
    """7 distinct served models, newest first by 10 s steps."""
    routes = []
    for index, (served, provider, who, agent, ms, ttft, out) in enumerate(MANY_MODELS):
        routes.append(make_route(
            1792464002401 + index, index * 10, agent=agent,
            requested=f"{provider}/{served}", served=served, provider=provider, who=who,
            conv=f"01a1546e-3108-75{index + 10:02d}", ms=ms, ttft=ttft, out=out))
    return routes


def scenario_one() -> list[dict]:
    """A single provider with a single model: the smallest useful card."""
    return [
        make_route(1792464002101, 20, agent="codex", requested="officeace/glm-5.3",
                   served="glm-5.3", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-74a1", ms=3000, ttft=600, out=240),
    ]


def scenario_quota() -> list[dict]:
    """Three providers leaving 89% (green), 40% (amber) and 15% (red)."""
    return [
        make_route(1792464002701, 10, agent="codex", requested="officeace/glm-5.3",
                   served="glm-5.3", provider="officeace", who="alex@example.com",
                   conv="01a1546e-3108-77a1", ms=3000, ttft=600, out=240),
        make_route(1792464002702, 40, agent="dsh", requested="codearts/glm-5.3",
                   served="glm-5.3", provider="codearts", who="hid8c21@example.com",
                   conv="01a1546e-3108-77a2", ms=2500, ttft=520, out=200),
        make_route(1792464002703, 70, agent="claude", requested="trae-cn/deepseek-v4.1-flash",
                   served="deepseek-v4.1-flash", provider="trae-cn", who="t97226@example.com",
                   conv="01a1546e-3108-77a3", ms=3800, ttft=760, out=304),
    ]


def scenario_flaky() -> list[dict]:
    """Same data as ``ok``; the transport breaks after the first answers."""
    return scenario_ok()


def scenario_empty() -> list[dict]:
    """A gateway that has answered nothing yet: an empty, live snapshot."""
    return []


BUILDERS = {
    "ok": scenario_ok,
    "error": scenario_error,
    "live": scenario_live,
    "missing": scenario_missing,
    "many": scenario_many,
    "one": scenario_one,
    "quota": scenario_quota,
    "flaky": scenario_flaky,
    "empty": scenario_empty,
}


def reroute_count(route: dict) -> int:
    models = {try_item.get("model") for try_item in route.get("tries", []) if try_item.get("model")}
    return max(0, len(models) - 1)


def is_error(route: dict) -> bool:
    return bool(route.get("error")) or (Number(route.get("status")) >= 400)


def Number(value) -> float:  # noqa: N802 - keeps the intent obvious next to the widget's JS
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def trace_payload(routes: list[dict], seq: int) -> dict:
    return {
        "object": "trace",
        "now": datetime.now().astimezone().isoformat(timespec="seconds"),
        "seq": seq,
        "pid": PID,
        "serves": "app",
        "totals": {
            "requests": len(routes),
            "rerouted": sum(1 for route in routes if reroute_count(route) > 0),
            "errors": sum(1 for route in routes if is_error(route)),
        },
        "routes": routes,
    }


def usage_payload(requested: str) -> dict:
    period = requested if requested in USAGE_PERIODS else "30d"
    return {"period": period, **USAGE[period]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mock-magpie/1.0"
    sys_version = ""

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - base class signature
        return

    def handle_one_request(self) -> None:
        # A stopped client (the widget aborts its long poll on reconnect) must
        # not print a traceback on the mock's console.
        try:
            super().handle_one_request()
        except OSError:
            self.close_connection = True

    def do_GET(self) -> None:  # noqa: N802 - base class signature
        parsed = urlparse(self.path)
        if parsed.path == "/v1/magpie/usage":
            query = parse_qs(parsed.query)
            self.send_json(usage_payload(query.get("period", ["30d"])[0]))
            return
        if parsed.path not in ("/v1/magpie/trace", "/"):
            self.send_json({"error": f"mock_models has no route for {parsed.path}"}, status=404)
            return

        query = parse_qs(parsed.query)
        REQUESTS["trace"] += 1
        seq = REQUESTS["trace"]
        if SCENARIO == "flaky" and seq >= FLAKY_AFTER:
            if FLAKY_MODE == "close":
                self.abort_connection()
            else:
                self.send_json({"error": "mock_models flaky: trace unavailable"}, status=500)
            return

        if query.get("after", ["0"])[0] not in ("", "0") and "wait" in query:
            time.sleep(max(0, WAIT_MS) / 1000)
        self.send_json(trace_payload(ROUTES, seq))

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            self.close_connection = True

    def abort_connection(self) -> None:
        """Answer nothing at all: the client sees a dropped connection."""
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


ROUTES: list[dict] = []
SCENARIO = "ok"


def banner(port: int) -> str:
    rerouted = sum(1 for route in ROUTES if reroute_count(route) > 0)
    errors = sum(1 for route in ROUTES if is_error(route))
    base = ROUTES[0]["time"] if ROUTES else stamp(0)
    lines = [
        f"mock magpie for the model session list on http://127.0.0.1:{port}",
        f"  scenario : {SCENARIO} — {SCENARIO_NOTES[SCENARIO]}",
        f"  routes   : {len(ROUTES)} · rerouted {rerouted} · errors {errors} · pid {PID}",
        f"  trace    : GET /v1/magpie/trace?after=<seq>&wait=1  (holds {WAIT_MS} ms)",
        f"  usage    : GET /v1/magpie/usage?period=today|7d|30d|all",
        f"  times    : frozen at startup, newest route {base} (offsets never move)",
    ]
    if SCENARIO == "flaky":
        mode = "drop the connection" if FLAKY_MODE == "close" else "answer HTTP 500"
        lines.append(f"  flaky    : from trace request #{FLAKY_AFTER} on, {mode}")
    lines.append("  env      : MOCK_PID, MOCK_WAIT_MS, MOCK_FLAKY_AFTER, MOCK_FLAKY_MODE")
    lines.append(f"  use      : BUSY_MAGPIE_GATEWAY=http://127.0.0.1:{port} npx electron . --preview --remote-debugging-port=9223")
    return "\n".join(lines)


def usage() -> str:
    return (
        "usage: python tools/mock_models.py [port] [scenario]\n"
        f"       port default 3500; scenario default ok, one of: {', '.join(SCENARIOS)}\n"
        f"       python tools/mock_models.py 3500 many\n"
    )


def configure_streams() -> None:
    """Print the banner as UTF-8 with ``errors="replace"``.

    A Windows console is often on a legacy code page (GBK) where a stray
    character used to take the whole server down at startup. UTF-8 keeps the
    Chinese scenario notes readable in a UTF-8 terminal (and in redirected
    logs); ``errors="replace"`` means a legacy console shows a placeholder
    instead of losing the process.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv: list[str]) -> int:
    global SCENARIO, ROUTES
    configure_streams()
    args = argv[1:]
    if any(arg in ("-h", "--help") for arg in args):
        print(usage())
        return 0
    if len(args) > 2:
        print(usage(), file=sys.stderr)
        return 2
    port = 3500
    if args:
        try:
            port = int(args[0])
        except ValueError:
            print(f"mock_models: port {args[0]!r} is not an integer\n{usage()}", file=sys.stderr)
            return 2
    SCENARIO = args[1] if len(args) > 1 else "ok"
    if SCENARIO not in BUILDERS:
        print(f"mock_models: unknown scenario {SCENARIO!r}\n{usage()}", file=sys.stderr)
        return 2
    if FLAKY_MODE not in ("http500", "close"):
        print(f"mock_models: MOCK_FLAKY_MODE={FLAKY_MODE!r} is not http500/close", file=sys.stderr)
        return 2
    ROUTES = BUILDERS[SCENARIO]()
    try:
        server = Server(("127.0.0.1", port), Handler)
    except OSError as error:
        print(f"mock_models: cannot listen on 127.0.0.1:{port}: {error}", file=sys.stderr)
        return 2
    print(banner(port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("mock_models: stopped", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))