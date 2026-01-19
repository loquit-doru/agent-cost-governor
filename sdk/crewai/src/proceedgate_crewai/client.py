"""
ProceedGate API Client
"""

from typing import Optional, Any
import httpx
from pydantic import BaseModel


class GateCheckRequest(BaseModel):
    policy_id: str
    action: str
    actor: dict
    context: dict


class GateCheckResponse(BaseModel):
    allowed: bool
    decision_id: str
    proceed_token: Optional[str] = None
    reason_code: Optional[str] = None
    policy: dict


class ProceedGateClient:
    """Client for ProceedGate Governor API."""
    
    def __init__(
        self,
        api_key: str,
        workspace_id: str,
        base_url: str = "https://governor.proceedgate.dev",
    ):
        self.api_key = api_key
        self.workspace_id = workspace_id
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=30.0)
    
    def __del__(self):
        self._client.close()
    
    def check(
        self,
        action: str,
        policy_id: str = "retry_friction_v1",
        context: Optional[dict] = None,
    ) -> GateCheckResponse:
        """Check if an action is allowed."""
        
        request = GateCheckRequest(
            policy_id=policy_id,
            action=action,
            actor={
                "id": f"crewai-agent:{self.workspace_id}",
                "project": self.workspace_id,
            },
            context=context or {},
        )
        
        response = self._client.post(
            f"{self.base_url}/v1/governor/check",
            json=request.model_dump(),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        
        data = response.json()
        return GateCheckResponse(**data)
    
    def redeem(self, decision_id: str, tx_hash: str) -> dict:
        """Redeem a decision after payment."""
        
        response = self._client.post(
            f"{self.base_url}/v1/governor/redeem",
            json={
                "decision_id": decision_id,
                "tx_hash": tx_hash,
            },
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        
        return response.json()
    
    def get_balance(self) -> dict:
        """Get current balance."""
        
        response = self._client.get(
            f"{self.base_url}/v1/billing/balance",
            params={"workspace_id": self.workspace_id},
            headers={
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        
        return response.json()
