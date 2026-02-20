"""
ProceedGate adapter for CrewAI.

Usage:
    from proceedgate_crewai import ProceedGateCallback

    gate = ProceedGateCallback(
        api_key="pg_ws_...",
        base_url="https://governor.proceedgate.dev",
    )

    @agent.step_callback
    def on_step(step):
        gate.check(step)
"""

import hashlib
import json
import urllib.request
import urllib.error
from typing import Optional, Any


class ProceedGateCallback:
    """CrewAI step_callback adapter for ProceedGate governance."""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://governor.proceedgate.dev",
        fail_open: bool = True,
    ):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.fail_open = fail_open
        self._attempt_counter: dict[str, int] = {}

    def check(self, step: Any) -> dict:
        """
        Call ProceedGate check before each CrewAI step.
        Raises ProceedGateBlocked if the step is blocked.
        Returns the gate response dict on success.
        """
        action = getattr(step, "tool", None) or "tool_call"
        task_hash = self._hash(getattr(step, "task", ""))
        step_hash = self._hash(f"{action}:{getattr(step, 'tool_input', '')}")

        # Count attempts per step pattern
        pattern_key = f"{action}:{task_hash}"
        self._attempt_counter[pattern_key] = self._attempt_counter.get(pattern_key, 0) + 1
        attempt = self._attempt_counter[pattern_key]

        # Extract model info if available
        model = getattr(step, "model", None)
        cost_estimate = getattr(step, "cost_estimate", None)

        context: dict[str, Any] = {
            "attempt_in_window": attempt,
            "window_seconds": 60,
            "task_hash": task_hash,
            "step_hash": step_hash,
        }
        if model:
            context["model"] = model
        if cost_estimate is not None:
            context["cost_estimate"] = cost_estimate

        body = {
            "policy_id": "retry_friction_v1",
            "action": action if action in ("tool_call", "llm_call", "browser_action", "api_call") else "tool_call",
            "actor": {
                "id": f"crewai-agent:{getattr(step, 'agent_name', 'unknown')}",
                "project": self.api_key.split("_")[-1][:8] if "_" in self.api_key else "crewai",
            },
            "context": context,
        }

        try:
            result = self._post("/v1/governor/check", body)
            if not result.get("allowed", True):
                raise ProceedGateBlocked(
                    reason=result.get("reason", "blocked"),
                    zone=result.get("zone", "unknown"),
                    pattern_count=result.get("pattern_count", 0),
                    cost_saved_usd=result.get("cost_saved_usd", 0),
                    response=result,
                )
            return result
        except ProceedGateBlocked:
            raise
        except Exception as e:
            if self.fail_open:
                return {"allowed": True, "error": str(e), "fail_open": True}
            raise

    def reset_attempts(self, pattern_key: Optional[str] = None):
        """Reset attempt counters. Call between distinct tasks."""
        if pattern_key:
            self._attempt_counter.pop(pattern_key, None)
        else:
            self._attempt_counter.clear()

    def _post(self, path: str, body: dict) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace")
            try:
                return json.loads(body_text)
            except json.JSONDecodeError:
                return {"error": body_text, "status": e.code}

    @staticmethod
    def _hash(value: str) -> str:
        return hashlib.sha256(str(value).encode()).hexdigest()[:16]


class ProceedGateBlocked(Exception):
    """Raised when ProceedGate blocks.a step."""

    def __init__(self, reason: str, zone: str, pattern_count: int, cost_saved_usd: float, response: dict):
        self.reason = reason
        self.zone = zone
        self.pattern_count = pattern_count
        self.cost_saved_usd = cost_saved_usd
        self.response = response
        super().__init__(f"ProceedGate blocked: {reason} (zone={zone}, count={pattern_count})")


class PydanticAIMiddleware:
    """
    ProceedGate middleware for Pydantic AI agents.

    Usage:
        from proceedgate_crewai import PydanticAIMiddleware

        gate = PydanticAIMiddleware(api_key="pg_ws_...")

        # Before each agent step:
        gate.before_step(model="gpt-4o", tool="search", input_text="query")
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://governor.proceedgate.dev",
        fail_open: bool = True,
    ):
        self._gate = ProceedGateCallback(api_key=api_key, base_url=base_url, fail_open=fail_open)

    def before_step(
        self,
        model: str = "unknown",
        tool: Optional[str] = None,
        input_text: str = "",
        cost_estimate: Optional[float] = None,
    ) -> dict:
        """Check ProceedGate before a Pydantic AI step."""

        class _Step:
            pass

        step = _Step()
        step.tool = tool or "llm_call"  # type: ignore
        step.task = input_text  # type: ignore
        step.tool_input = input_text  # type: ignore
        step.agent_name = "pydantic-ai"  # type: ignore
        step.model = model  # type: ignore
        step.cost_estimate = cost_estimate  # type: ignore
        return self._gate.check(step)

    def reset(self):
        self._gate.reset_attempts()
