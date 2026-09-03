from .schema import AgentDecision, DecideRequest

def fallback_decision(request: DecideRequest, taxonomy: dict, reason='AI unavailable') -> AgentDecision:
    failure_type = taxonomy.get('failure_type') or ('autopay_failed' if request.failed_payment.failure_source == 'subscription' else 'soft')
    action = 'escalate_hitl'  # confidence is 0.50, below the HITL floor
    return AgentDecision(decision_type=action, failure_type=failure_type, explanation=reason, customer_message='', confidence=0.5, model_version='fallback', should_escalate_hitl=True, taxonomy_match=taxonomy.get('match'), tools_used=['lookup_failure_taxonomy'])
