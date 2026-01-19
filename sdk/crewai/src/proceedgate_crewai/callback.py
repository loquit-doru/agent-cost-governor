"""
ProceedGate Callback for CrewAI
"""

from typing import Optional, Callable, Literal, Any
import re
from .client import ProceedGateClient
from .exceptions import FrictionRequiredError


class ProceedGateCallback:
    """
    CrewAI callback handler for ProceedGate cost governance.
    
    Tracks and controls costs during crew execution.
    """
    
    def __init__(
        self,
        api_key: str,
        workspace_id: str,
        base_url: str = "https://governor.proceedgate.dev",
        policy_id: str = "retry_friction_v1",
        on_friction: Literal["block", "warn"] = "warn",
    ):
        self.client = ProceedGateClient(api_key, workspace_id, base_url)
        self.policy_id = policy_id
        self.on_friction = on_friction
        
        self.total_cost = 0.0
        self.step_count = 0
        self.attempt_counts: dict[str, int] = {}
        
        # Event handlers
        self._on_gate_check: list[Callable] = []
        self._on_friction: list[Callable] = []
        self._on_cost_update: list[Callable] = []
    
    def on_gate_check(self, func: Callable) -> Callable:
        """Decorator to register gate check handler."""
        self._on_gate_check.append(func)
        return func
    
    def on_friction(self, func: Callable) -> Callable:
        """Decorator to register friction handler."""
        self._on_friction.append(func)
        return func
    
    def on_cost_update(self, func: Callable) -> Callable:
        """Decorator to register cost update handler."""
        self._on_cost_update.append(func)
        return func
    
    def _emit_gate_check(self, result: dict):
        for handler in self._on_gate_check:
            try:
                handler(result)
            except Exception:
                pass
    
    def _emit_friction(self, info: dict):
        for handler in self._on_friction:
            try:
                handler(info)
            except Exception:
                pass
    
    def _emit_cost_update(self, total: float):
        for handler in self._on_cost_update:
            try:
                handler(total)
            except Exception:
                pass
    
    def _get_attempt_count(self, key: str) -> int:
        count = self.attempt_counts.get(key, 0) + 1
        self.attempt_counts[key] = count
        return count
    
    def _parse_price(self, price_str: str) -> float:
        """Extract numeric value from price string like '0.004 USDC'."""
        match = re.search(r"([\d.]+)", price_str)
        if match:
            return float(match.group(1))
        return 0.0
    
    def gate_check(
        self,
        action: str,
        context: Optional[dict] = None,
    ) -> bool:
        """
        Check if an action is allowed.
        
        Returns True if allowed, raises or warns on friction.
        """
        attempt_key = f"{action}:{context.get('tool', 'default') if context else 'default'}"
        attempt = self._get_attempt_count(attempt_key)
        
        full_context = {
            "attempt_in_window": attempt,
            "window_seconds": 30,
            **(context or {}),
        }
        
        result = self.client.check(action, self.policy_id, full_context)
        
        self._emit_gate_check({
            "allowed": result.allowed,
            "decision_id": result.decision_id,
            "reason_code": result.reason_code,
            "price": result.policy.get("friction_price"),
        })
        
        if result.allowed:
            # Track cost
            price = self._parse_price(result.policy.get("friction_price", "0"))
            self.total_cost += price
            self.step_count += 1
            self._emit_cost_update(self.total_cost)
            return True
        
        # Friction required
        friction_info = {
            "decision_id": result.decision_id,
            "reason_code": result.reason_code,
            "price": result.policy.get("friction_price", "unknown"),
            "action": action,
        }
        self._emit_friction(friction_info)
        
        if self.on_friction == "block":
            raise FrictionRequiredError(
                f"Action '{action}' blocked. Friction required: {friction_info['price']}",
                decision_id=result.decision_id,
                reason_code=result.reason_code or "friction",
                price=friction_info["price"],
                action=action,
            )
        
        # Warn and continue
        print(f"[ProceedGate] Warning: Action '{action}' requires friction: {friction_info['price']}")
        return True
    
    # CrewAI callback interface
    def on_task_start(self, task: Any):
        """Called when a task starts."""
        self.gate_check("task_start", {"task": str(task)})
    
    def on_task_end(self, task: Any, output: Any):
        """Called when a task ends."""
        pass
    
    def on_tool_start(self, tool_name: str, tool_input: Any):
        """Called when a tool is invoked."""
        self.gate_check("tool_call", {"tool": tool_name})
    
    def on_tool_end(self, tool_name: str, tool_output: Any):
        """Called when a tool completes."""
        pass
    
    def on_llm_start(self, prompt: str):
        """Called before LLM invocation."""
        self.gate_check("llm_call", {
            "input_length": len(prompt),
            "confidence": 0.8,
        })
    
    def on_llm_end(self, response: str):
        """Called after LLM response."""
        pass
    
    def reset(self):
        """Reset tracking state."""
        self.total_cost = 0.0
        self.step_count = 0
        self.attempt_counts.clear()
