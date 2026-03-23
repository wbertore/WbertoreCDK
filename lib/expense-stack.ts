import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { RUST_ARTIFACT_S3_KEY_PARAM_NAME } from './common';

export const RECEIPT_UPLOADS_BUCKET_EXPORT = 'ReceiptUploadsBucketName';

export class ExpenseStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Declared so the pipeline parameter override applies when a Lambda is added to this stack
        new cdk.CfnParameter(this, RUST_ARTIFACT_S3_KEY_PARAM_NAME);

        const receiptUploadsBucket = new Bucket(this, 'receipt-uploads', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                expiration: cdk.Duration.days(14),
            }],
        });

        new cdk.CfnOutput(this, 'ReceiptUploadsBucketName', {
            value: receiptUploadsBucket.bucketName,
            exportName: RECEIPT_UPLOADS_BUCKET_EXPORT,
        });
    }
}
