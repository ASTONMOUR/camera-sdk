"""In-process telemetry: count events, measure latency, nothing persisted.

This is the minimum needed for the /api/health endpoint to report what the
service has seen since it started. No external sink, no disk writes, no
personal data — just counters and timings that reset on restart.
"""

from __future__ import annotations

import time
from collections import defaultdict
from threading import Lock

_lock = Lock()
_counters: dict[str, int] = defaultdict(int)
_latencies: dict[str, list[float]] = defaultdict(list)
# ponytail: global lock; per-event locks if throughput matters


def record(event: str, latency_ms: float | None = None) -> None:
    """Increment the counter for event and, if given, append a latency sample."""
    with _lock:
        _counters[event] += 1
        if latency_ms is not None:
            _latencies[event].append(latency_ms)


def snapshot() -> dict:
    """Return a copy of all counters and p50/p95 latencies."""
    with _lock:
        counts = dict(_counters)
        lats = {k: _percentiles(v) for k, v in _latencies.items() if v}
    return {"counts": counts, "latency_ms": lats}


def _percentiles(samples: list[float]) -> dict[str, float]:
    s = sorted(samples)
    n = len(s)
    return {
        "p50": round(s[int(n * 0.5)], 1),
        "p95": round(s[min(int(n * 0.95), n - 1)], 1),
        "n": n,
    }


class Timer:
    """Context manager that records event + elapsed ms on exit."""

    def __init__(self, event: str) -> None:
        self._event = event
        self._start = 0.0

    def __enter__(self) -> "Timer":
        self._start = time.monotonic()
        return self

    def __exit__(self, *_) -> None:
        elapsed = (time.monotonic() - self._start) * 1000.0
        record(self._event, elapsed)
