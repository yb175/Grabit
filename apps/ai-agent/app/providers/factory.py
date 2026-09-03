import os
from .gemini import GeminiProvider
from .openai import OpenAIProvider

def get_provider():
    provider = os.getenv('LLM_PROVIDER', 'gemini')
    if provider == 'gemini': return GeminiProvider()
    if provider == 'openai': return OpenAIProvider()
    raise ValueError(f'Unsupported LLM_PROVIDER: {provider}')
