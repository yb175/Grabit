import os
from fastapi import APIRouter
from .schema import DecideRequest, AgentDecision
from .taxonomy import lookup_failure_taxonomy
from .tools import get_payment_status
from .prompts import build_prompt
from .providers.factory import get_provider
from .guardrails import validate_decision
from .fallback import fallback_decision

router = APIRouter()

def decide(request: DecideRequest) -> AgentDecision:
    payment = request.failed_payment
    status = get_payment_status(payment.razorpay_payment_id)
    if status['status'] == 'paid':
        return AgentDecision(decision_type='stop', failure_type='soft', explanation='Payment is already paid.', confidence=1, model_version='payment-status', tools_used=['get_payment_status'])
    taxonomy = lookup_failure_taxonomy(payment.failure_code, payment.failure_reason, payment.failure_source, payment.payment_method)
    tools = ['lookup_failure_taxonomy']
    try:
        raw = get_provider().decide(build_prompt(request, taxonomy))
        raw['tools_used'] = tools
        raw['model_version'] = os.getenv('LLM_MODEL', 'gemini-3.1-flash-lite-preview')
        return validate_decision(raw, request, taxonomy)
    except Exception as exc:
        return fallback_decision(request, taxonomy, f'Bounded fallback: {type(exc).__name__}')

@router.post('/v1/decide', response_model=AgentDecision)
def post_decide(request: DecideRequest):
    return decide(request)

@router.get('/health')
def health():
    return {'status': 'ok', 'provider': os.getenv('LLM_PROVIDER', 'gemini'), 'model': os.getenv('LLM_MODEL', 'gemini-3.1-flash-lite-preview')}
