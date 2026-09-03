TAXONOMY = {
    # Specific / mandate keys first — matching is substring-based and order-sensitive,
    # so generic soft keys (insufficient_funds etc.) must come last (A2 regression).
    'emandate_execution_failed': ('autopay_failed', True, 'one_click'),
    'autopay_failed': ('autopay_failed', True, 'one_click'),
    'mandate_revoked': ('autopay_cancelled', False, 'stop'),
    'mandate_cancelled': ('autopay_cancelled', False, 'stop'),
    'mandate_paused': ('autopay_cancelled', False, 'stop'),
    'stolen_card': ('hard', False, 'stop'), 'pickup_card': ('hard', False, 'stop'),
    'lost_card': ('hard', False, 'stop'), 'do_not_honor': ('hard', False, 'escalate_hitl'),
    'invalid_account': ('hard', False, 'stop'), 'invalid_card_number': ('hard', False, 'stop'),
    'card_blocked': ('hard', False, 'stop'), 'suspected_fraud': ('hard', False, 'escalate_hitl'),
    'insufficient_funds': ('soft', True, 'one_click'), 'low_balance': ('soft', True, 'one_click'),
    'issuer_unavailable': ('soft', True, 'delay'), 'bank_timeout': ('soft', True, 'delay'),
    'gateway_timeout': ('soft', True, 'delay'), 'debit_failed': ('soft', True, 'one_click'),
    'temporary_decline': ('soft', True, 'one_click'),
}

def lookup_failure_taxonomy(failure_code, failure_reason, failure_source, payment_method):
    # failure_code first: a machine code beats free-text reason ("emandate failed
    # due to insufficient funds" must be autopay_failed, not soft).
    code = str(failure_code or '').lower().strip().replace(' ', '_')
    text = ' '.join(str(x or '').lower() for x in (failure_reason, failure_source, payment_method)).replace(' ', '_')
    key = next((k for k in TAXONOMY if k in code), None)
    if not key:
        key = next((k for k in TAXONOMY if k in text), None)
    if not key:
        return {'known': False, 'failure_type': None, 'retryable': None, 'default_action': None, 'notes': 'Unknown failure; classify only into the bounded taxonomy.'}
    failure_type, retryable, action = TAXONOMY[key]
    return {'known': True, 'failure_type': failure_type, 'retryable': retryable, 'default_action': action, 'notes': f'Static match: {key}.', 'match': key}
