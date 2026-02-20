# ProceedGate Framework Adapters

Zero-dependency Python adapters for integrating ProceedGate with popular AI agent frameworks.

## CrewAI

```python
from proceedgate_crewai import ProceedGateCallback

gate = ProceedGateCallback(api_key="pg_ws_your_key")

@agent.step_callback
def on_step(step):
    gate.check(step)  # Raises ProceedGateBlocked if storm detected
```

## Pydantic AI

```python
from proceedgate_crewai import PydanticAIMiddleware

gate = PydanticAIMiddleware(api_key="pg_ws_your_key")

# Before each step:
gate.before_step(model="gpt-4o", tool="search", input_text="query")
```

## Proxy Mode (Zero-Code — Any Framework)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://governor.proceedgate.dev/proxy/openai",
    api_key="pg_ws_your_key",                    # ProceedGate key
    default_headers={
        "X-Upstream-Api-Key": "sk-your-openai-key"  # Real OpenAI key
    },
)

# Every request is auto-governed!
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)
```

## Features

- **Fail-open by default** — network errors don't break your agent
- **Automatic attempt counting** — tracks retries per step pattern
- **Zero dependencies** — uses only Python stdlib (`urllib`, `hashlib`)
- **LLM cost tracking** — pass model/cost_estimate for cost-based policies
