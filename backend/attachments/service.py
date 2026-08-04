"""Business logic for S3-backed attachment storage: presigned-URL validation/issuance and
GDPR bulk deletion. Framework-agnostic: raises plain exceptions rather than
fastapi.HTTPException. backend/attachments/router.py translates them to HTTP status codes.
"""
import logging
import os
import uuid

import boto3
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)

S3_BUCKET = os.getenv("S3_BUCKET")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
ATTACHMENT_PREFIX = "note-attachments"
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024  # 100 MB (videos are large)
# Total across ALL of an account's attachments. Without this, per-file size was the only limit
# and a single account could park unbounded storage in the bucket for free, forever - the one
# cost that keeps accruing after the user stops using the app. Env-overridable so the ceiling can
# be raised for a paid tier without a code change.
MAX_TOTAL_ATTACHMENT_BYTES = int(os.getenv("MAX_TOTAL_ATTACHMENT_BYTES", 2 * 1024 * 1024 * 1024))
ALLOWED_ATTACHMENT_MIME = {
    # images
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic",
    # video
    "video/mp4", "video/quicktime", "video/webm", "video/x-msvideo",
    "video/x-matroska", "video/3gpp",
    # audio
    "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav",
    "audio/aac", "audio/ogg", "audio/webm",
    # docs
    "application/pdf", "text/plain", "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
ALLOWED_ATTACHMENT_EXT = {
    "jpg", "jpeg", "png", "gif", "webp", "heic",
    "mp4", "mov", "webm", "avi", "mkv", "3gp", "m4v",
    "mp3", "m4a", "wav", "aac", "ogg", "oga",
    "pdf", "txt", "csv",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
}


class AttachmentStorageUnavailableError(Exception):
    pass


class AttachmentTooLargeError(Exception):
    pass


class UnsupportedAttachmentTypeError(Exception):
    pass


class AttachmentQuotaExceededError(Exception):
    """The account's total storage would be exceeded by this upload."""


class AttachmentAccessDeniedError(Exception):
    pass


class AttachmentStorageError(Exception):
    pass


def get_s3_client():
    """Return a boto3 S3 client, or None if attachment storage isn't configured.
    Credentials come from the standard AWS env vars / IAM role."""
    if not S3_BUCKET:
        return None
    return boto3.client("s3", region_name=AWS_REGION)


def presign_upload(user_id: str, filename: str, mime_type: str, size: int, used_bytes: int = 0) -> dict:
    """Validate a file and return a presigned POST for direct-to-S3 upload. The object key is
    generated server-side under the caller's prefix so a client can never write outside its own
    namespace."""
    s3 = get_s3_client()
    if s3 is None:
        raise AttachmentStorageUnavailableError()

    if size <= 0 or size > MAX_ATTACHMENT_BYTES:
        raise AttachmentTooLargeError(f"File too large (max {MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB)")

    # Checked BEFORE issuing the presigned URL: once the client holds one, S3 accepts the upload
    # directly and the server never sees it again, so this is the only point where the account
    # total can still be enforced.
    if used_bytes + size > MAX_TOTAL_ATTACHMENT_BYTES:
        remaining = max(0, MAX_TOTAL_ATTACHMENT_BYTES - used_bytes)
        raise AttachmentQuotaExceededError(
            f"Not enough storage. You have {remaining // (1024 * 1024)}MB left of "
            f"{MAX_TOTAL_ATTACHMENT_BYTES // (1024 * 1024 * 1024)}GB. Delete some attachments to free space."
        )

    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext not in ALLOWED_ATTACHMENT_EXT or mime_type not in ALLOWED_ATTACHMENT_MIME:
        raise UnsupportedAttachmentTypeError()

    attachment_id = str(uuid.uuid4())
    key = f"{ATTACHMENT_PREFIX}/{user_id}/{attachment_id}.{ext}"

    try:
        presigned = s3.generate_presigned_post(
            Bucket=S3_BUCKET,
            Key=key,
            Fields={"Content-Type": mime_type},
            Conditions=[
                {"Content-Type": mime_type},
                ["content-length-range", 1, MAX_ATTACHMENT_BYTES],
            ],
            ExpiresIn=300,
        )
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to presign attachment: {e}")
        raise AttachmentStorageError("Could not prepare upload")

    file_url = f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"
    return {
        "id": attachment_id,
        "key": key,
        "upload_url": presigned["url"],
        "fields": presigned["fields"],
        "file_url": file_url,
    }


def delete_attachment(user_id: str, key: str) -> None:
    """Delete a stored attachment. Scoped to the caller's own prefix."""
    s3 = get_s3_client()
    if s3 is None:
        raise AttachmentStorageUnavailableError()

    if not key.startswith(f"{ATTACHMENT_PREFIX}/{user_id}/"):
        raise AttachmentAccessDeniedError("Not allowed to delete this file")

    try:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to delete attachment {key}: {e}")
        raise AttachmentStorageError("Could not delete file")


def presign_download(user_id: str, key: str) -> str:
    """Return a presigned GET URL for viewing/downloading an attachment. Scoped to the caller's
    own prefix. Used for tap-to-open and shareable links."""
    s3 = get_s3_client()
    if s3 is None:
        raise AttachmentStorageUnavailableError()

    if not key.startswith(f"{ATTACHMENT_PREFIX}/{user_id}/"):
        raise AttachmentAccessDeniedError("Not allowed to access this file")

    try:
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=7 * 24 * 3600,  # 7 days (SigV4 max) - covers tap-to-open and shared links
        )
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to presign download for {key}: {e}")
        raise AttachmentStorageError("Could not prepare download")


def delete_user_attachments(user_id: str) -> None:
    """Best-effort deletion of every stored attachment under the user's prefix. Called from
    account deletion (GDPR Art. 17) - failures are logged, not raised, so a storage hiccup
    never blocks the rest of the erasure."""
    s3 = get_s3_client()
    if not s3:
        return
    try:
        prefix = f"{ATTACHMENT_PREFIX}/{user_id}/"
        paginator = s3.get_paginator("list_objects_v2")
        batch = []
        for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                batch.append({"Key": obj["Key"]})
                if len(batch) == 1000:
                    s3.delete_objects(Bucket=S3_BUCKET, Delete={"Objects": batch})
                    batch = []
        if batch:
            s3.delete_objects(Bucket=S3_BUCKET, Delete={"Objects": batch})
    except Exception as e:
        logger.error(f"S3 attachment cleanup failed for user {user_id}: {e}")


async def used_storage_bytes(db, user_id: str) -> int:
    """Total bytes this account currently has stored in attachments.

    Takes `db` as a parameter rather than importing a client, per the dependency-injection rule in
    CLAUDE.md - this file otherwise has no database dependency at all.

    Aggregates server-side instead of pulling notes and summing in Python: a note carries base64
    images inline, so fetching every note just to read `attachments[].size_bytes` would move
    megabytes over the wire on every single upload.

    Counts what the NOTES claim, which is the same source the client sees and can delete. An
    orphaned S3 object (upload succeeded, note write failed) is therefore not counted - it would
    otherwise be uncountable-and-undeletable from the user's point of view, which is a worse
    failure than slightly under-counting.
    """
    pipeline = [
        {"$match": {"user_id": user_id, "has_attachments": True}},
        {"$unwind": "$attachments"},
        {"$group": {"_id": None, "total": {"$sum": "$attachments.size_bytes"}}},
    ]
    try:
        rows = await db.notes.aggregate(pipeline).to_list(1)
    except Exception as e:
        # Never block an upload because the usage lookup failed - fail open on the quota rather
        # than making a transient database hiccup look like "you are out of space".
        logger.warning("Attachment usage lookup failed for %s: %s", user_id, e)
        return 0
    return int(rows[0]["total"]) if rows else 0
