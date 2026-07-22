import os

from fastapi import HTTPException
from openai import AsyncOpenAI


def get_openai_client() -> AsyncOpenAI:
    """Create an OpenAI client from environment configuration."""
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured")
    return AsyncOpenAI(api_key=api_key)
