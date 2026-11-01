import unittest

from python.research_service import analyze


class ResearchServiceTests(unittest.TestCase):
    def candles(self, count: int = 160):
        output = []
        price = 100.0
        for index in range(count):
            price += 0.12 + (0.2 if index % 7 < 4 else -0.15)
            output.append({
                "open": price - 0.08,
                "high": price + 0.3,
                "low": price - 0.3,
                "close": price,
                "volume": 100 + index,
            })
        return output

    def test_report_contains_ranked_playbooks_and_risk_profile(self):
        report = analyze({
            "symbol": "XAUUSD",
            "timeframe": "1H",
            "riskProfile": "LOW",
            "candles": self.candles(),
        })
        self.assertEqual(report["engine"], "aurex-python-research-v1")
        self.assertEqual(report["risk"]["suggestedRiskPercent"], 0.5)
        self.assertEqual(len(report["playbooks"]), 6)
        scores = [item["score"] for item in report["playbooks"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertIn(report["market"]["researchDirection"], {"BUY", "SELL", "WAIT"})

    def test_short_payload_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "60 OHLC"):
            analyze({"candles": self.candles(20)})


if __name__ == "__main__":
    unittest.main()
