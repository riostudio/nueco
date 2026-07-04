import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ServerlessClamscan } from 'cdk-serverless-clamscan';

export interface ClamavStackProps extends cdk.StackProps {
  /** Name of the EXISTING S3 bucket that holds note attachments (the app's `S3_BUCKET`). */
  bucketName: string;
}

/**
 * Deploys AWS Labs' serverless ClamAV scanner against the app's attachments bucket.
 *
 * On every `ObjectCreated`, a ClamAV Lambda scans the object and sets the S3 object tag
 * `scan-status` (CLEAN / INFECTED / ...). A scheduled Lambda keeps virus definitions
 * fresh. The MemoPad backend reads that tag and blocks any download whose status isn't
 * CLEAN (fail-safe). See ../README.md.
 */
export class ClamavStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ClamavStackProps) {
    super(scope, id, props);

    // Import the pre-existing bucket by name (it's created/managed outside this app).
    const attachments = s3.Bucket.fromBucketName(this, 'AttachmentsBucket', props.bucketName);

    new ServerlessClamscan(this, 'NoteAttachmentScan', {
      buckets: [attachments],
    });
  }
}
