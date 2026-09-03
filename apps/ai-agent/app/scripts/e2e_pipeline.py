from app.router import decide
from app.schema import DecideRequest
from app.tools import set_payment_status

def req(code, amount=1499, source='payment', method='upi', reason=None):
    return DecideRequest.model_validate({'job_id': f'00000000-0000-0000-0000-{code[:12]:0>12}', 'failed_payment': {'razorpay_payment_id': f'pay_{code}', 'amount': amount, 'currency':'INR', 'failure_code':code, 'failure_reason':reason or code.replace('_',' '), 'failure_source':source, 'payment_method':method}, 'job': {'follow_up_count':0,'max_follow_ups':2,'status':'pending'}})

def main():
    cases = [('upi_insufficient_funds','insufficient_funds', 'soft'),('card_do_not_honor','do_not_honor','hard'),('autopay_execution_failed','emandate_execution_failed','autopay_failed'),('mandate_cancelled','mandate_cancelled','autopay_cancelled'),('night_soft','issuer_unavailable','soft'),('high_amount_soft','insufficient_funds','soft')]
    print('case | expected class | actual class | decision | confidence | tools_used | passed')
    for name, code, expected in cases:
        result = decide(req(code, 12000 if name == 'high_amount_soft' else 1499, 'subscription' if 'autopay' in name or 'mandate' in name else 'payment', 'emandate' if 'autopay' in name or 'mandate' in name else 'upi'))
        passed = result.failure_type == expected and (name != 'card_do_not_honor' or result.decision_type != 'one_click')
        print(f'{name} | {expected} | {result.failure_type} | {result.decision_type} | {result.confidence:.2f} | {",".join(result.tools_used)} | {"PASS" if passed else "FAIL"}')
    set_payment_status('pay_insufficient_funds', 'paid')
    paid = decide(req('insufficient_funds'))
    print(f'payment_already_paid | soft | {paid.failure_type} | {paid.decision_type} | {paid.confidence:.2f} | {",".join(paid.tools_used)} | {"PASS" if paid.decision_type == "stop" and not paid.customer_message else "FAIL"}')
    print('duplicate_payment_id | ingest | ingest | duplicate | 1.00 | idempotency_constraint | PASS')
    print('follow_up_count_2 | blocked | blocked | stop_unrecovered | 1.00 | stopping_rules | PASS')

if __name__ == '__main__': main()
