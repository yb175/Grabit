import json, os, urllib.request
from .base import LLMProvider

class OpenAIProvider(LLMProvider):
    def __init__(self):
        self.key = os.getenv('LLM_API_KEY', '')
        self.model = os.getenv('LLM_MODEL', 'gpt-4.1-mini')
        self.base = os.getenv('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
    def decide(self, prompt):
        if not self.key: raise RuntimeError('LLM_API_KEY is not configured')
        body = json.dumps({'model': self.model, 'temperature': 0, 'response_format': {'type': 'json_object'}, 'messages': [{'role': 'system', 'content': prompt}]}).encode()
        req = urllib.request.Request(f'{self.base}/chat/completions', body, {'Content-Type': 'application/json', 'Authorization': f'Bearer {self.key}'})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.load(response)
        return json.loads(data['choices'][0]['message']['content'])
