"""
ProceedGate Exceptions
"""


class ProceedGateError(Exception):
    """Base exception for ProceedGate errors."""
    pass


class FrictionRequiredError(ProceedGateError):
    """Raised when an action requires friction resolution."""
    
    def __init__(
        self,
        message: str,
        decision_id: str,
        reason_code: str,
        price: str,
        action: str,
    ):
        super().__init__(message)
        self.decision_id = decision_id
        self.reason_code = reason_code
        self.price = price
        self.action = action


class BudgetExceededError(ProceedGateError):
    """Raised when budget limit is exceeded."""
    
    def __init__(
        self,
        message: str,
        current_cost: float,
        max_budget: float,
    ):
        super().__init__(message)
        self.current_cost = current_cost
        self.max_budget = max_budget
