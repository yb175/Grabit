from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

DecisionType = Literal['stop', 'delay', 'one_click', 'escalate_hitl']
FailureType = Literal['hard', 'soft', 'autopay_failed', 'autopay_cancelled']
PaymentMethod = Literal['upi', 'card', 'netbanking', 'emandate']

class FailedPayment(BaseModel):
    model_config = ConfigDict(extra='forbid')
    razorpay_payment_id: str
    amount: float = Field(ge=0)
    currency: str = 'INR'
    failure_code: str | None = None
    failure_reason: str | None = None
    failure_source: str | None = None
    payment_method: PaymentMethod
    customer_name: str | None = None
    customer_phone: str | None = None

class JobContext(BaseModel):
    model_config = ConfigDict(extra='forbid')
    follow_up_count: int = Field(ge=0)
    max_follow_ups: int = Field(ge=0)
    status: str

class DecideRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_id: str
    failed_payment: FailedPayment
    job: JobContext

class AgentDecision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    decision_type: DecisionType
    failure_type: FailureType
    explanation: str = Field(max_length=300)
    customer_message: str = Field(default='', max_length=300)
    action_payload: dict = Field(default_factory=dict)
    confidence: float = Field(ge=0, le=1)
    model_version: str
    should_escalate_hitl: bool = False
    taxonomy_match: str | None = None
    tools_used: list[str] = Field(default_factory=list)
