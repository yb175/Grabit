TAXONOMY = {
    'stolen_card': ('hard', False, 'stop'), 'pickup_card': ('hard', False, 'stop'),
    'lost_card': ('hard', False, 'stop'), 'do_not_honor': ('hard', False, 'escalate_hitl'),
    'invalid_account': ('hard', False, 'stop'), 'invalid_card_number': ('hard', False, 'stop'),
    'card_blocked': ('hard', False, 'stop'), 'suspected_fraud': ('hard', False, 'escalate_hitl'),
    'mandate_revoked': ('autopay_cancelled', False, 'stop'), 'mandate_cancelled': ('autopay_cancelled', False, 'stop'),
    'mandate_paused': ('autopay_cancelled', False, 'stop'),
    'insufficient_funds': ('soft', True, 'one_click'), 'low_balance': ('soft', True, 'one_click'),
    'issuer_unavailable': ('soft', True, 'delay'), 'bank_timeout': ('soft', True, 'delay'),
    'gateway_timeout': ('soft', True, 'delay'), 'debit_failed': ('soft', True, 'one_click'),
    'temporary_decline': ('soft', True, 'one_click'),
    'emandate_execution_failed': ('autopay_failed', True, 'one_click'),
    'autopay_failed': ('autopay_failed', True, 'one_click'),
}

def lookup_failure_taxonomy(failure_code, failure_reason, failure_source, payment_method):
    text = ' '.join(str(x or '').lower() for x in (failure_code, failure_reason, failure_source, payment_method))
    key = next((k for k in TAXONOMY if k in text.replace(' ', '_')), None)
    if not key:
        return {'known': False, 'failure_type': None, 'retryable': None, 'default_action': None, 'notes': 'Unknown failure; classify only into the bounded taxonomy.'}
    failure_type, retryable, action = TAXONOMY[key]
    return {'known': True, 'failure_type': failure_type, 'retryable': retryable, 'default_action': action, 'notes': f'Static match: {key}.' , 'match': key}
