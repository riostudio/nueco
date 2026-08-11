from typing import Literal, Optional, get_args

from pydantic import BaseModel, ConfigDict, Field

Sentiment = Literal["positive", "negative"]

VALID_SENTIMENTS = frozenset(get_args(Sentiment))


class FeedbackCreate(BaseModel):
    # Deliberately `str` rather than Sentiment: an unknown sentiment is answered with a 400 (see
    # service.submit), and typing the field would have FastAPI reject it with a 422 first - a
    # different status and body than the client handles. VALID_SENTIMENTS above is what the service
    # checks against, so the accepted values are still declared in exactly one place.
    sentiment: str
    tag: Optional[str] = None
    text: str = ""
    note_count_at_submission: int = 0
    app_version: str = ""
    platform: str = ""


# Length cap on the triage summary. The prompt asks for "a single short sentence", so anything near
# this is already off-script; the cap is a bound on what reaches the database, not a target.
MAX_TRIAGE_SUMMARY_CHARS = 500


class FeedbackTriage(BaseModel):
    """The triage model's reply.

    Feedback text is attacker-controlled in the ordinary sense - it's free text from a user, fed
    straight into a prompt - so the reply is untrusted input like any other request body, and this
    is the boundary it has to cross before any of it is stored. Previously the three fields were
    read off a bare `json.loads` with `.get()` and written to the document as-is, so a reply that
    ignored the prompt (or was steered into ignoring it) could put arbitrary strings of arbitrary
    length into aiCategory/aiPriority - the fields triage exists to make sortable.
    """

    # Ignore rather than forbid: an extra key the model volunteers is not a reason to throw away a
    # reply whose three real fields are all valid.
    model_config = ConfigDict(extra="ignore")

    category: Literal["bug", "feature_request", "ux_friction", "praise", "unclear"]
    priority: Literal["low", "medium", "high", "urgent"]
    summary: str = Field(min_length=1, max_length=MAX_TRIAGE_SUMMARY_CHARS)
