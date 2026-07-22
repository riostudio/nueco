import logging
import os
import uuid

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException

logger = logging.getLogger(__name__)

S3_BUCKET = os.getenv("S3_BUCKET")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
ATTACHMENT_PREFIX = "note-attachments"
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024  # 100 MB (videos are large)
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


def get_s3_client():
    """Return a boto3 S3 client, or None if attachment storage isn't configured.
    Credentials come from the standard AWS env vars / IAM role."""
    if not S3_BUCKET:
        return None
    return boto3.client("s3", region_name=AWS_REGION)


def presign_upload(user_id: str, filename: str, mime_type: str, size: int) -> dict:
    """Validate a file and return a presigned POST for direct-to-S3 upload. The object key is
    generated server-side under the caller's prefix so a client can never write outside its own
    namespace."""
    s3 = get_s3_client()
    if s3 is None:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")

    if size <= 0 or size > MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large (max {MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB)",
        )

    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext not in ALLOWED_ATTACHMENT_EXT or mime_type not in ALLOWED_ATTACHMENT_MIME:
        raise HTTPException(status_code=400, detail="File type not allowed")

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
        raise HTTPException(status_code=502, detail="Could not prepare upload")

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
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")

    if not key.startswith(f"{ATTACHMENT_PREFIX}/{user_id}/"):
        raise HTTPException(status_code=403, detail="Not allowed to delete this file")

    try:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to delete attachment {key}: {e}")
        raise HTTPException(status_code=502, detail="Could not delete file")


def presign_download(user_id: str, key: str) -> str:
    """Return a presigned GET URL for viewing/downloading an attachment. Scoped to the caller's
    own prefix. Used for tap-to-open and shareable links."""
    s3 = get_s3_client()
    if s3 is None:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")

    if not key.startswith(f"{ATTACHMENT_PREFIX}/{user_id}/"):
        raise HTTPException(status_code=403, detail="Not allowed to access this file")

    try:
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": key},
            ExpiresIn=7 * 24 * 3600,  # 7 days (SigV4 max) - covers tap-to-open and shared links
        )
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to presign download for {key}: {e}")
        raise HTTPException(status_code=502, detail="Could not prepare download")


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
