import json, os, urllib.request
from .base import LLMProvider

class GeminiProvider(LLMProvider):
    def __init__(self):
        self.key = os.getenv('LLM_API_KEY') or os.getenv('GEMINI_API_KEY', '')
        self.model = os.getenv('LLM_MODEL', 'gemini-3.1-flash-lite-preview')
        self.base = os.getenv('LLM_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta')
    def decide(self, prompt):
        if not self.key: raise RuntimeError('LLM_API_KEY is not configured')
        url = f'{self.base}/models/{self.model}:generateContent?key={self.key}'
        body = json.dumps({'contents': [{'parts': [{'text': prompt}]}], 'generationConfig': {'responseMimeType': 'application/json'}}).encode()
        req = urllib.request.Request(url, body, {'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.load(response)
        text = data['candidates'][0]['content']['parts'][0]['text']
        return json.loads(text)
