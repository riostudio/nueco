from pydantic import BaseModel


class DeleteAccountRequest(BaseModel):
    password: str
