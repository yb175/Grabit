import os
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.guardrails import validate_decision
from app.schema import DecideRequest

client = TestClient(app)

def request(code='insufficient_funds', amount=1499, source='payment'):
    return {'job_id':'00000000-0000-0000-0000-000000000001','failed_payment':{'razorpay_payment_id':'pay_test','amount':amount,'currency':'INR','failure_code':code,'failure_reason':code.replace('_',' '),'failure_source':source,'payment_method':'upi'},'job':{'follow_up_count':0,'max_follow_ups':2,'status':'pending'}}

def test_health(): assert client.get('/health').json()['status'] == 'ok'

def test_fallback_soft_is_bounded():
    result = client.post('/v1/decide', json=request()).json()
    assert result['failure_type'] == 'soft'
    assert result['decision_type'] in ('one_click', 'escalate_hitl')

def test_hard_rejects_invented_one_click():
    req = DecideRequest.model_validate(request('do_not_honor'))
    with pytest.raises(ValueError):
        validate_decision({'decision_type':'one_click','failure_type':'hard','explanation':'x','customer_message':'pay','action_payload':{},'confidence':.9,'model_version':'x','should_escalate_hitl':False,'taxonomy_match':'do_not_honor','tools_used':[],'offer_discount':10}, req, {'failure_type':'hard'})

def test_high_amount_escalates():
    result = client.post('/v1/decide', json=request(amount=10000)).json()
    assert result['decision_type'] == 'escalate_hitl'
    assert result['customer_message'] == ''

def test_decide_rejects_customer_pii_fields():
    # customer_name, customer_phone, email must be rejected by pydantic extra='forbid'
    req_with_name = request()
    req_with_name['failed_payment']['customer_name'] = 'Aarav Sharma'
    res_name = client.post('/v1/decide', json=req_with_name)
    assert res_name.status_code == 422

    req_with_phone = request()
    req_with_phone['failed_payment']['customer_phone'] = '+919999999999'
    res_phone = client.post('/v1/decide', json=req_with_phone)
    assert res_phone.status_code == 422

    req_with_email = request()
    req_with_email['failed_payment']['email'] = 'customer@example.com'
    res_email = client.post('/v1/decide', json=req_with_email)
    assert res_email.status_code == 422

def test_decide_accepts_clean_payload_without_pii():
    clean_req = request(code='insufficient_funds', amount=499)
    res = client.post('/v1/decide', json=clean_req)
    assert res.status_code == 200
    data = res.json()
    assert data['decision_type'] in ('one_click', 'escalate_hitl')
    assert data['failure_type'] == 'soft'

def test_s1_and_h1_classification_without_pii():
    # S1 Golden case: UPI soft insufficient_funds
    s1_req = {
        'job_id': '11111111-1111-1111-1111-111111111101',
        'failed_payment': {
            'razorpay_payment_id': 'pay_opsS1',
            'amount': 299,
            'currency': 'INR',
            'failure_code': 'insufficient_funds',
            'failure_reason': 'Not enough balance in account',
            'failure_source': 'payment',
            'payment_method': 'upi',
        },
        'job': {'follow_up_count': 0, 'max_follow_ups': 2, 'status': 'pending'},
    }
    s1_res = client.post('/v1/decide', json=s1_req)
    assert s1_res.status_code == 200
    s1_data = s1_res.json()
    assert s1_data['failure_type'] == 'soft'
    assert s1_data['decision_type'] in ('one_click', 'escalate_hitl')

    # H1 Golden case: Card hard stolen_card
    h1_req = {
        'job_id': '11111111-1111-1111-1111-111111111106',
        'failed_payment': {
            'razorpay_payment_id': 'pay_opsH1',
            'amount': 2499,
            'currency': 'INR',
            'failure_code': 'stolen_card',
            'failure_reason': 'Card reported stolen, pickup card at issuer',
            'failure_source': 'payment',
            'payment_method': 'card',
        },
        'job': {'follow_up_count': 0, 'max_follow_ups': 2, 'status': 'pending'},
    }
    h1_res = client.post('/v1/decide', json=h1_req)
    assert h1_res.status_code == 200
    h1_data = h1_res.json()
    assert h1_data['failure_type'] == 'hard'
    assert h1_data['decision_type'] in ('stop', 'escalate_hitl')
    assert h1_data['customer_message'] == ''


