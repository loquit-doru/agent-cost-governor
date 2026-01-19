"""
ProceedGate CrewAI Integration

Cost governance for CrewAI agents.
"""

from .callback import ProceedGateCallback
from .tools import gated_tool, GatedTool
from .crew import BudgetAwareCrew
from .client import ProceedGateClient
from .exceptions import ProceedGateError, FrictionRequiredError, BudgetExceededError

__all__ = [
    "ProceedGateCallback",
    "gated_tool",
    "GatedTool", 
    "BudgetAwareCrew",
    "ProceedGateClient",
    "ProceedGateError",
    "FrictionRequiredError",
    "BudgetExceededError",
]

__version__ = "1.0.0"
