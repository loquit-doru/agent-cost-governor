"""
Budget-Aware Crew wrapper
"""

from typing import Optional, Any
from .callback import ProceedGateCallback
from .exceptions import BudgetExceededError


class BudgetAwareCrew:
    """
    Wrapper for CrewAI Crew with budget enforcement.
    
    Stops execution if budget is exceeded.
    """
    
    def __init__(
        self,
        crew: Any,  # crewai.Crew
        api_key: str,
        workspace_id: str,
        max_budget: float,
        base_url: str = "https://governor.proceedgate.dev",
        policy_id: str = "retry_friction_v1",
    ):
        self.crew = crew
        self.max_budget = max_budget
        
        self.callback = ProceedGateCallback(
            api_key=api_key,
            workspace_id=workspace_id,
            base_url=base_url,
            policy_id=policy_id,
            on_friction="warn",
        )
        
        # Register budget check on each cost update
        @self.callback.on_cost_update
        def check_budget(total_cost: float):
            if total_cost > self.max_budget:
                raise BudgetExceededError(
                    f"Budget exceeded: ${total_cost:.4f} > ${self.max_budget:.4f}",
                    current_cost=total_cost,
                    max_budget=self.max_budget,
                )
    
    @property
    def total_cost(self) -> float:
        return self.callback.total_cost
    
    @property
    def step_count(self) -> int:
        return self.callback.step_count
    
    def kickoff(self, inputs: Optional[dict] = None) -> Any:
        """
        Start crew execution with budget enforcement.
        
        Raises BudgetExceededError if budget is exceeded during execution.
        """
        self.callback.reset()
        
        # Check budget before starting
        if self.callback.total_cost >= self.max_budget:
            raise BudgetExceededError(
                f"Budget already exceeded before starting",
                current_cost=self.callback.total_cost,
                max_budget=self.max_budget,
            )
        
        # Add callback to crew if possible
        if hasattr(self.crew, 'callbacks'):
            if self.callback not in self.crew.callbacks:
                self.crew.callbacks.append(self.callback)
        
        try:
            if inputs:
                return self.crew.kickoff(inputs=inputs)
            return self.crew.kickoff()
        except BudgetExceededError:
            raise
        except Exception as e:
            # Re-raise with cost info
            raise RuntimeError(
                f"Crew execution failed after ${self.callback.total_cost:.4f} spent: {e}"
            ) from e
    
    def reset(self):
        """Reset tracking state."""
        self.callback.reset()
