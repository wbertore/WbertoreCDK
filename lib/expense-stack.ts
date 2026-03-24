import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, HttpMethods, EventType } from 'aws-cdk-lib/aws-s3';
import { SqsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Function, Code, Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, Role, AccountRootPrincipal, IGrantable } from 'aws-cdk-lib/aws-iam';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { EXPENSE_PROCESSOR_ARTIFACT_S3_KEY_PARAM_NAME, resolveArtifactKeyParams } from './common';

export const RECEIPT_UPLOADS_BUCKET_EXPORT = 'ReceiptUploadsBucketName';

export interface ExpenseStackProps extends cdk.StackProps {
    rustArtifactBucket: IBucket;
}

export class ExpenseStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ExpenseStackProps) {
        super(scope, id, props);

        const artifactKeys = resolveArtifactKeyParams(this, 'expense-stack');

        const receiptUploadsBucket = new Bucket(this, 'receipt-uploads', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                expiration: cdk.Duration.days(14),
            }],
            cors: [{
                allowedMethods: [HttpMethods.PUT],
                allowedOrigins: ['https://website.wbertore.dev', 'https://localhost:9000'],
                allowedHeaders: ['content-type'],
                maxAge: 3000,
            }],
        });

        new cdk.CfnOutput(this, 'ReceiptUploadsBucketName', {
            value: receiptUploadsBucket.bucketName,
            exportName: RECEIPT_UPLOADS_BUCKET_EXPORT,
        });

        const receiptUploadQueue = new Queue(this, 'receipt-upload-queue', {
            queueName: 'receipt-upload-queue',
            visibilityTimeout: cdk.Duration.seconds(60),
            deadLetterQueue: {
                maxReceiveCount: 3,
                queue: new Queue(this, 'receipt-upload-dlq', { queueName: 'receipt-upload-dlq' }),
            },
        });

        receiptUploadsBucket.addEventNotification(EventType.OBJECT_CREATED, new SqsDestination(receiptUploadQueue));

        const processedExpensesBucket = new Bucket(this, 'processed-expenses', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const expenseProcessor = new Function(this, 'expense-processor', {
            functionName: 'expense-processor',
            code: Code.fromBucket(props.rustArtifactBucket, artifactKeys.get(EXPENSE_PROCESSOR_ARTIFACT_S3_KEY_PARAM_NAME)!.valueAsString),
            runtime: Runtime.PROVIDED_AL2023,
            architecture: Architecture.ARM_64,
            handler: 'does_not_matter',
            timeout: cdk.Duration.seconds(60),
            environment: {
                PROCESSED_EXPENSES_BUCKET: processedExpensesBucket.bucketName,
            },
        });

        expenseProcessor.addEventSource(new SqsEventSource(receiptUploadQueue, {
            batchSize: 10,
        }));

        const localDevRole = new Role(this, 'expense-processor-local-dev-role', {
            roleName: 'expenseProcessorLocalDevRole',
            assumedBy: new AccountRootPrincipal(),
            description: 'Role for local testing with same permissions as expense-processor Lambda',
        });

        const grantExpenseProcessorPermissions = (grantables: IGrantable[]) => {
            grantables.forEach(grantable => {
                grantable.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
                    actions: ['textract:AnalyzeExpense'],
                    resources: ['*'],
                }));
                grantable.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
                    actions: ['bedrock:InvokeModel'],
                    resources: [`arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-haiku-*`],
                }));
                receiptUploadsBucket.grantRead(grantable);
                processedExpensesBucket.grantWrite(grantable);
            });
        };

        grantExpenseProcessorPermissions([expenseProcessor, localDevRole]);
    }
}
