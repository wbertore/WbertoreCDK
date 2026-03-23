import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, LifecycleRule } from 'aws-cdk-lib/aws-s3';

export const RECEIPT_UPLOADS_BUCKET_EXPORT = 'ReceiptUploadsBucketName';

export class ExpenseStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

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
