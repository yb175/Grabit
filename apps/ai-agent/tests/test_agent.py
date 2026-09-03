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
