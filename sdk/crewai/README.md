# proceedgate-crewai

CrewAI integration for ProceedGate cost governance.

## Installation

```bash
pip install proceedgate-crewai
```

## Quick Start

### As a Crew Callback

```python
from crewai import Crew, Agent, Task
from proceedgate_crewai import ProceedGateCallback

callback = ProceedGateCallback(
    api_key="your_api_key",
    workspace_id="my-workspace",
    on_friction="warn",  # or "block"
)

crew = Crew(
    agents=[...],
    tasks=[...],
    callbacks=[callback],
)

result = crew.kickoff()
print(f"Total cost: ${callback.total_cost:.4f}")
```

### As Tool Decorators

```python
from proceedgate_crewai import gated_tool

@gated_tool(
    api_key="your_api_key",
    workspace_id="my-workspace",
)
def expensive_api_call(query: str) -> str:
    """Call an expensive external API."""
    # Your logic here
    return "result"
```

### Budget-Aware Execution

```python
from proceedgate_crewai import BudgetAwareCrew

crew = BudgetAwareCrew(
    agents=[...],
    tasks=[...],
    api_key="your_api_key",
    workspace_id="my-workspace",
    max_budget=10.0,  # $10 USD
)

try:
    result = crew.kickoff()
except BudgetExceededError as e:
    print(f"Budget exceeded: {e.current_cost} > {e.max_budget}")
```

## Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `api_key` | ProceedGate API key | Required |
| `workspace_id` | Workspace identifier | Required |
| `base_url` | ProceedGate API URL | `https://governor.proceedgate.dev` |
| `policy_id` | Default policy | `retry_friction_v1` |
| `on_friction` | Friction handling | `"warn"` |

## Events

```python
callback = ProceedGateCallback(...)

@callback.on_gate_check
def handle_check(result):
    print(f"Gate check: allowed={result['allowed']}")

@callback.on_friction
def handle_friction(info):
    print(f"Friction required: {info['price']}")

@callback.on_cost_update
def handle_cost(total_cost):
    print(f"Running total: ${total_cost:.4f}")
```

## License

MIT
