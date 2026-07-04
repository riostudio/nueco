#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ClamavStack } from '../lib/clamav-stack';

const app = new cdk.App();

// The existing attachments bucket (same value as the backend's S3_BUCKET env var).
const bucketName = process.env.ATTACHMENTS_BUCKET || app.node.tryGetContext('bucketName');
if (!bucketName) {
  throw new Error('Set ATTACHMENTS_BUCKET=<your S3_BUCKET> (or -c bucketName=...) before deploying.');
}

new ClamavStack(app, 'MemoPadClamavStack', {
  bucketName,
  // Deploy into the account/region of your AWS creds (same region as the bucket).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
