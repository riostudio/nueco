# MemoPad attachment malware scanning (AWS Lambda + ClamAV)

Deploys AWS Labs' [`cdk-serverless-clamscan`](https://github.com/awslabs/cdk-serverless-clamscan)
against the app's existing S3 attachments bucket. Every uploaded file is scanned by a
ClamAV Lambda, which sets the S3 object tag **`scan-status`** (`CLEAN` / `INFECTED` / …).
The MemoPad backend reads that tag and **blocks any download whose status isn't `CLEAN`**
(fail-safe), so unscanned or infected files can never be opened.

> You run this in **your** AWS account — it needs your AWS credentials and can't be
> deployed from the app repo's CI. Everything the app code needs (backend gate + UI) is
> shipped separately and only depends on the `scan-status` tag this stack produces.

## Prerequisites
- Node 18+, AWS credentials configured (`aws sts get-caller-identity` works).
- Docker running locally (the construct bundles the ClamAV Lambda as a container image).
- The attachments bucket name = the backend's `S3_BUCKET`, and its region.

## Deploy
```bash
cd infra/clamav
npm install

export ATTACHMENTS_BUCKET="<your S3_BUCKET>"
export CDK_DEFAULT_REGION="<bucket region, e.g. us-east-1>"
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

npx cdk bootstrap    # once per account/region
npx cdk deploy
```
This creates: the ClamAV **scan Lambda**, a **virus-definitions** bucket + scheduled
updater Lambda, and an **S3 event notification** on the attachments bucket.

> **Imported-bucket note:** the bucket already exists, so the stack imports it by name and
> the construct adds the event notification via a bucket-notifications custom resource. If
> `cdk deploy` reports it can't manage notifications on an imported bucket, pin
> `cdk-serverless-clamscan` to the version matching your `aws-cdk-lib`, or add the
> `s3:ObjectCreated:*` → scan-Lambda notification once in the S3 console.

## Verify (do this before relying on it)
1. **Clean file** — upload any allowed file through the app (or `aws s3 cp`), then:
   ```bash
   aws s3api get-object-tagging --bucket "$ATTACHMENTS_BUCKET" --key "note-attachments/<user>/<id>.<ext>"
   ```
   Expect a `scan-status` tag of `CLEAN` within a few seconds.
2. **EICAR (harmless AV test file)** — this string is what every scanner flags as a test
   "virus"; it is NOT real malware:
   ```bash
   printf 'X5O!P%%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > eicar.txt
   aws s3 cp eicar.txt "s3://$ATTACHMENTS_BUCKET/note-attachments/_test/eicar.txt"
   # then get-object-tagging → expect scan-status = INFECTED
   aws s3 rm "s3://$ATTACHMENTS_BUCKET/note-attachments/_test/eicar.txt"
   ```
   **Confirm the exact tag key and the CLEAN/INFECTED values** here — the backend gate keys
   off `scan-status == "CLEAN"` (anything else blocks), so the infected spelling doesn't
   matter, but the key (`scan-status`) and the clean value (`CLEAN`) must match.

## Bulk-scan existing objects (one-time, at rollout)
Files uploaded before this stack existed have no tag, so the backend treats them as
"pending" and blocks them. Re-emit a create event for each existing object to get it
scanned (copy-in-place; content unchanged):
```bash
aws s3api list-objects-v2 --bucket "$ATTACHMENTS_BUCKET" --prefix "note-attachments/" \
  --query 'Contents[].Key' --output text | tr '\t' '\n' | while read -r key; do
    [ -n "$key" ] && aws s3 cp "s3://$ATTACHMENTS_BUCKET/$key" "s3://$ATTACHMENTS_BUCKET/$key" \
      --metadata-directive REPLACE --content-type "$(aws s3api head-object --bucket "$ATTACHMENTS_BUCKET" --key "$key" --query ContentType --output text)"
done
```
Run once after deploy; watch the scan Lambda's CloudWatch logs and re-check a few tags.

## Cost
Lambda invocations per upload (a few seconds each) + storage for virus definitions +
the scheduled definitions update. No per-scan API fee.
