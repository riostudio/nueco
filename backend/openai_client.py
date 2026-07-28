import os

from openai import AsyncOpenAI


class OpenAIConfigError(Exception):
    """Raised when no OpenAI API key is configured. Plain exception, not fastapi.HTTPException -
    this module is called directly from service.py files (textai/, feedback/), which must stay
    framework-agnostic; each router's existing generic exception handler already translates an
    unexpected failure here into a 500, so no HTTPException needs to originate this deep."""


def get_openai_client() -> AsyncOpenAI:
    """Create an OpenAI client from environment configuration."""
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        raise OpenAIConfigError("OpenAI API key not configured")
    return AsyncOpenAI(api_key=api_key)
