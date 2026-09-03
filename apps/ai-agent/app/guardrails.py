from .schema import AgentDecision, DecideRequest
from .taxonomy import TAXONOMY

ALLOWED = {'stop', 'delay', 'one_click', 'escalate_hitl'}
# Fraud smell in free text forces HITL regardless of what the model says (X4 regression).
FRAUD_SMELL = ('fraud', 'not authorized', 'unauthorized', 'stolen', 'lost card', 'pickup card')

def validate_decision(raw: dict, request: DecideRequest, taxonomy: dict) -> AgentDecision:
    if set(raw) - set(AgentDecision.model_fields): raise ValueError('invented action or extra key')
    result = AgentDecision.model_validate(raw)
    if result.decision_type not in ALLOWED: raise ValueError('invalid decision')
    if taxonomy.get('failure_type') == 'hard' and result.decision_type == 'one_click': raise ValueError('hard failure cannot one-click')
    if taxonomy.get('failure_type'):
        result.failure_type = taxonomy['failure_type']
    # taxonomy_match must be a real taxonomy key — model-invented keys are dropped.
    if result.taxonomy_match not in TAXONOMY:
        result.taxonomy_match = None
    if taxonomy.get('failure_type') in ('hard', 'autopay_cancelled'):
        result.decision_type = 'stop' if result.decision_type == 'one_click' else result.decision_type
        result.customer_message = ''
    if result.failure_type == 'hard' and result.decision_type == 'one_click': raise ValueError('hard failure cannot one-click')
    if result.confidence < 0.55 or request.failed_payment.amount >= float(__import__('os').getenv('HITL_AMOUNT_THRESHOLD', '10000')):
        result.decision_type = 'escalate_hitl'; result.should_escalate_hitl = True; result.customer_message = ''
    smell_text = f"{request.failed_payment.failure_reason or ''} {request.failed_payment.failure_code or ''}".lower()
    if any(w in smell_text for w in FRAUD_SMELL):
        result.decision_type = 'escalate_hitl'; result.should_escalate_hitl = True; result.customer_message = ''
    if result.decision_type in ('stop', 'escalate_hitl'): result.customer_message = ''
    return result
