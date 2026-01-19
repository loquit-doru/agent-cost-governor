"""
ProceedGate Tool Decorator for CrewAI
"""

from typing import Callable, Optional, TypeVar, Any
from functools import wraps
from .client import ProceedGateClient
from .exceptions import FrictionRequiredError

F = TypeVar("F", bound=Callable[..., Any])


class GatedTool:
    """
    Wrapper class for tools with ProceedGate cost governance.
    """
    
    def __init__(
        self,
        func: Callable,
        api_key: str,
        workspace_id: str,
        base_url: str = "https://governor.proceedgate.dev",
        policy_id: str = "retry_friction_v1",
        on_friction: str = "warn",
    ):
        self.func = func
        self.client = ProceedGateClient(api_key, workspace_id, base_url)
        self.policy_id = policy_id
        self.on_friction = on_friction
        self.attempt_count = 0
        
        # Preserve function metadata
        self.__name__ = func.__name__
        self.__doc__ = func.__doc__
    
    def __call__(self, *args, **kwargs):
        self.attempt_count += 1
        
        result = self.client.check(
            action="tool_call",
            policy_id=self.policy_id,
            context={
                "attempt_in_window": self.attempt_count,
                "window_seconds": 30,
                "tool": self.__name__,
            },
        )
        
        if not result.allowed:
            price = result.policy.get("friction_price", "unknown")
            
            if self.on_friction == "block":
                raise FrictionRequiredError(
                    f"Tool '{self.__name__}' blocked. Friction required: {price}",
                    decision_id=result.decision_id,
                    reason_code=result.reason_code or "friction",
                    price=price,
                    action="tool_call",
                )
            
            print(f"[ProceedGate] Warning: Tool '{self.__name__}' requires friction: {price}")
        
        # Reset on success
        if result.allowed:
            self.attempt_count = 0
        
        return self.func(*args, **kwargs)


def gated_tool(
    api_key: str,
    workspace_id: str,
    base_url: str = "https://governor.proceedgate.dev",
    policy_id: str = "retry_friction_v1",
    on_friction: str = "warn",
) -> Callable[[F], F]:
    """
    Decorator to wrap a function with ProceedGate cost governance.
    
    Usage:
        @gated_tool(api_key="...", workspace_id="...")
        def my_expensive_tool(query: str) -> str:
            return external_api_call(query)
    """
    def decorator(func: F) -> F:
        wrapper = GatedTool(
            func=func,
            api_key=api_key,
            workspace_id=workspace_id,
            base_url=base_url,
            policy_id=policy_id,
            on_friction=on_friction,
        )
        return wrapper  # type: ignore
    
    return decorator
