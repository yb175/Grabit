from .taxonomy import lookup_failure_taxonomy

_PAYMENT_STATUS: dict[str, str] = {}

def set_payment_status(payment_id: str, status: str) -> None:
    _PAYMENT_STATUS[payment_id] = status

def get_payment_status(razorpay_payment_id: str):
    status = _PAYMENT_STATUS.get(razorpay_payment_id, 'unknown')
    return {'status': status if status in ('paid', 'failed') else 'unknown'}
