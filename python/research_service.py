"""AUREX Pro research sidecar.

Standard-library-only HTTP service for playbook research. It never creates or
persists live signals; the TypeScript V3 engine remains the execution authority.
"""

from __future__ import annotations

import json
import math
import os
import statistics
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def clamp(value: float) -> int:
    return max(0, min(100, round(value)))


def analyze(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("candles")
    if not isinstance(raw, list) or len(raw) < 60:
        raise ValueError("At least 60 OHLC candles are required.")

    candles: list[dict[str, float]] = []
    for item in raw[-1500:]:
        if not isinstance(item, dict):
            continue
        values = [item.get(key) for key in ("open", "high", "low", "close")]
        if not all(finite(value) for value in values):
            continue
        candle = {key: float(item[key]) for key in ("open", "high", "low", "close")}
        candle["volume"] = float(item.get("volume", 0)) if finite(item.get("volume", 0)) else 0.0
        candles.append(candle)
    if len(candles) < 60:
        raise ValueError("Not enough valid OHLC candles were supplied.")

    closes = [item["close"] for item in candles]
    highs = [item["high"] for item in candles]
    lows = [item["low"] for item in candles]
    volumes = [item["volume"] for item in candles]
    true_ranges: list[float] = []
    for index, item in enumerate(candles):
        previous = closes[index - 1] if index else item["open"]
        true_ranges.append(max(item["high"] - item["low"], abs(item["high"] - previous), abs(item["low"] - previous)))

    close = closes[-1]
    atr = mean(true_ranges[-14:])
    sma20 = mean(closes[-20:])
    sma50 = mean(closes[-50:])
    slope_window = closes[-50:]
    slope = (slope_window[-1] - slope_window[0]) / max(abs(slope_window[0]), 1e-12)
    recent_high = max(highs[-100:])
    recent_low = min(lows[-100:])
    span = max(recent_high - recent_low, 1e-12)
    range_position = (close - recent_low) / span
    volume_ratio = volumes[-1] / mean(volumes[-20:]) if mean(volumes[-20:]) > 0 else 0.0
    volatility_percent = atr / max(close, 1e-12) * 100

    if sma20 > sma50 and slope > 0:
        trend = "BULLISH"
        direction = "BUY"
    elif sma20 < sma50 and slope < 0:
        trend = "BEARISH"
        direction = "SELL"
    else:
        trend = "MIXED"
        direction = "WAIT"

    distance_sma20 = abs(close - sma20) / max(atr, 1e-12)
    breakout_distance = min(abs(close - recent_high), abs(close - recent_low)) / max(atr, 1e-12)
    fib_levels = {
        "23.6": recent_high - 0.236 * span,
        "38.2": recent_high - 0.382 * span,
        "50.0": recent_high - 0.5 * span,
        "61.8": recent_high - 0.618 * span,
        "78.6": recent_high - 0.786 * span,
    }
    fib_distance = min(abs(close - value) for value in fib_levels.values()) / max(atr, 1e-12)
    support = min(lows[-20:])
    resistance = max(highs[-20:])
    sr_distance = min(abs(close - support), abs(close - resistance)) / max(atr, 1e-12)

    playbooks = [
        {"id": "TREND_CONTINUATION", "label": "Trend Continuation", "score": clamp(35 + min(abs(slope) * 3000, 35) + (20 if trend != "MIXED" else 0)), "detail": f"SMA20 {sma20:.5g} / SMA50 {sma50:.5g}; normalized slope {slope:.3%}."},
        {"id": "PULLBACK_CONTINUATION", "label": "Pullback Continuation", "score": clamp(90 - distance_sma20 * 35 + (15 if trend != "MIXED" else 0)), "detail": f"Price is {distance_sma20:.2f} ATR from the 20-period mean."},
        {"id": "BREAKOUT_RETEST", "label": "Breakout & Retest", "score": clamp(88 - breakout_distance * 30 + min(volume_ratio, 2) * 6), "detail": f"Nearest 100-bar boundary is {breakout_distance:.2f} ATR away; volume ratio {volume_ratio:.2f}x."},
        {"id": "FIBONACCI_RETRACEMENT", "label": "Fibonacci Retracement", "score": clamp(92 - fib_distance * 38), "detail": f"Nearest Fibonacci level is {fib_distance:.2f} ATR away."},
        {"id": "SUPPLY_DEMAND", "label": "Supply & Demand", "score": clamp(86 - sr_distance * 28 + (10 if range_position < 0.25 or range_position > 0.75 else 0)), "detail": f"Range position {range_position:.1%}; nearby demand {support:.5g}, supply {resistance:.5g}."},
        {"id": "SUPPORT_RESISTANCE_BOUNCE", "label": "S/R Bounce", "score": clamp(90 - sr_distance * 35), "detail": f"Nearest short-term S/R is {sr_distance:.2f} ATR away."},
    ]
    playbooks.sort(key=lambda item: item["score"], reverse=True)

    profile = str(payload.get("riskProfile") or "MEDIUM").upper()
    risk_settings = {
        "LOW": {"suggestedRiskPercent": 0.5, "qualityFloor": 80, "minimumR": 1.5},
        "MEDIUM": {"suggestedRiskPercent": 1.0, "qualityFloor": 70, "minimumR": 1.0},
        "HIGH": {"suggestedRiskPercent": 2.0, "qualityFloor": 62, "minimumR": 1.0},
    }.get(profile, {"suggestedRiskPercent": 1.0, "qualityFloor": 70, "minimumR": 1.0})

    return {
        "engine": "aurex-python-research-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "symbol": str(payload.get("symbol") or ""),
        "timeframe": str(payload.get("timeframe") or ""),
        "candles": len(candles),
        "market": {
            "trend": trend,
            "researchDirection": direction,
            "close": close,
            "atr14": atr,
            "volatilityPercent": volatility_percent,
            "volumeRatio": volume_ratio,
            "support": support,
            "resistance": resistance,
            "rangePosition": range_position,
        },
        "fibonacci": fib_levels,
        "risk": {"profile": profile, **risk_settings},
        "playbooks": playbooks,
        "disclaimer": "Research context only. Live trade decisions remain controlled by the primary closed-candle analysis.",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "AurexResearch/1.0"

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_json(200, {"ok": True, "service": "aurex-python-research-v1"})
        else:
            self.send_json(404, {"error": "Route not found."})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/analyze":
            self.send_json(404, {"error": "Route not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8_000_000:
                raise ValueError("Invalid research request size.")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object.")
            self.send_json(200, analyze(payload))
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:  # keep sidecar failure isolated from live API
            self.send_json(500, {"error": f"Research failed: {error}"})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[python-research] {self.address_string()} {fmt % args}")


if __name__ == "__main__":
    host = os.environ.get("PYTHON_RESEARCH_HOST", "127.0.0.1")
    port = int(os.environ.get("PYTHON_RESEARCH_PORT", "8790"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"AUREX Python research listening on http://{host}:{port}")
    server.serve_forever()
