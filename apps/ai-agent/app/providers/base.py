from abc import ABC, abstractmethod
from typing import Any

class LLMProvider(ABC):
    @abstractmethod
    def decide(self, prompt: str) -> dict[str, Any]: ...
