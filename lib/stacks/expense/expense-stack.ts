import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, HttpMethods, EventType } from 'aws-cdk-lib/aws-s3';
import { SqsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Function, Code, Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, Role, AccountRootPrincipal, IGrantable } from 'aws-cdk-lib/aws-iam';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { EXPENSE_PROCESSOR_ARTIFACT_S3_KEY_PARAM_NAME, resolveArtifactKeyParams } from '../../constants';

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

        const expensesTable = new Table(this, 'expenses-table', {
            tableName: 'expenses',
            partitionKey: { name: 'PK', type: AttributeType.STRING },
            sortKey: { name: 'SK', type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const expenseProcessor = new Function(this, 'expense-processor', {
            functionName: 'expense-processor',
            code: Code.fromBucket(props.rustArtifactBucket, artifactKeys.get(EXPENSE_PROCESSOR_ARTIFACT_S3_KEY_PARAM_NAME)!.valueAsString),
            runtime: Runtime.PROVIDED_AL2023,
            architecture: Architecture.ARM_64,
            handler: 'does_not_matter',
            timeout: cdk.Duration.seconds(60),
            environment: {
                EXPENSES_TABLE_NAME: expensesTable.tableName,
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
                    resources: [
                        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-haiku-*`,
                        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-*`,
                        `arn:aws:bedrock:${this.region}:*:inference-profile/us.anthropic.claude-haiku-*`,
                    ],
                }));
                receiptUploadsBucket.grantRead(grantable);
                expensesTable.grantWriteData(grantable);
            });
        };

        grantExpenseProcessorPermissions([expenseProcessor, localDevRole]);

        localDevRole.addToPolicy(new PolicyStatement({
            actions: ['lambda:GetFunctionConfiguration'],
            resources: [expenseProcessor.functionArn],
        }));
    }
}
