import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, HttpMethods, EventType } from 'aws-cdk-lib/aws-s3';
import { SqsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Function, Code, Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { PolicyStatement, Role, AccountRootPrincipal, IGrantable, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import {
    EXPENSE_PROCESSOR_ARTIFACT_S3_KEY_PARAM_NAME,
    DOCUMENT_ANALYSIS_TRIGGER_S3_KEY_PARAM_NAME,
    DOCUMENT_ANALYSIS_PROCESSOR_S3_KEY_PARAM_NAME,
    resolveArtifactKeyParams,
} from '../../constants';

export const RECEIPT_UPLOADS_BUCKET_EXPORT = 'ReceiptUploadsBucketName';
export const EXPENSES_TABLE_NAME_EXPORT = 'ExpensesTableName';

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

        receiptUploadsBucket.addEventNotification(EventType.OBJECT_CREATED, new SqsDestination(receiptUploadQueue), { prefix: 'receipts/' });

        const expensesTable = new Table(this, 'expenses-table', {
            tableName: 'expenses',
            partitionKey: { name: 'PK', type: AttributeType.STRING },
            sortKey: { name: 'SK', type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        new cdk.CfnOutput(this, 'ExpensesTableName', {
            value: expensesTable.tableName,
            exportName: EXPENSES_TABLE_NAME_EXPORT,
        });

        const expenseProcessorLogGroup = new logs.LogGroup(this, 'expense-processor-logs', {
            logGroupName: '/aws/lambda/expense-processor',
            retention: logs.RetentionDays.ONE_WEEK,
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
            logGroup: expenseProcessorLogGroup,
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
                    actions: ['textract:*'],
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

        // --- Document Analysis Pipeline ---

        // SQS queue for new uploads to the statements/ prefix
        const statementUploadQueue = new Queue(this, 'statement-upload-queue', {
            queueName: 'statement-upload-queue',
            visibilityTimeout: cdk.Duration.seconds(60),
            deadLetterQueue: {
                maxReceiveCount: 3,
                queue: new Queue(this, 'statement-upload-dlq', { queueName: 'statement-upload-dlq' }),
            },
        });

        receiptUploadsBucket.addEventNotification(
            EventType.OBJECT_CREATED,
            new SqsDestination(statementUploadQueue),
            { prefix: 'statements/' },
        );

        // SNS topic for Textract job completion notifications
        const textractCompletionTopic = new Topic(this, 'textract-completion-topic', {
            topicName: 'textract-completion-topic',
        });

        // SQS queue subscribed to the SNS topic for the processor lambda
        const textractCompletionQueue = new Queue(this, 'textract-completion-queue', {
            queueName: 'textract-completion-queue',
            visibilityTimeout: cdk.Duration.seconds(60),
            deadLetterQueue: {
                maxReceiveCount: 3,
                queue: new Queue(this, 'textract-completion-dlq', { queueName: 'textract-completion-dlq' }),
            },
        });

        textractCompletionTopic.addSubscription(new SqsSubscription(textractCompletionQueue));
        textractCompletionTopic.addToResourcePolicy(new PolicyStatement({
            principals: [new ServicePrincipal('textract.amazonaws.com')],
            actions: ['sns:Publish'],
            resources: [textractCompletionTopic.topicArn],
        }));

        // Lambda: triggered by new statement uploads, starts Textract job
        const documentAnalysisTriggerLogGroup = new logs.LogGroup(this, 'document-analysis-trigger-logs', {
            logGroupName: '/aws/lambda/document-analysis-trigger',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const documentAnalysisTrigger = new Function(this, 'document-analysis-trigger', {
            functionName: 'document-analysis-trigger',
            code: Code.fromBucket(props.rustArtifactBucket, artifactKeys.get(DOCUMENT_ANALYSIS_TRIGGER_S3_KEY_PARAM_NAME)!.valueAsString),
            runtime: Runtime.PROVIDED_AL2023,
            architecture: Architecture.ARM_64,
            handler: 'does_not_matter',
            timeout: cdk.Duration.seconds(60),
            environment: {
                TEXTRACT_SNS_TOPIC_ARN: textractCompletionTopic.topicArn,
            },
            logGroup: documentAnalysisTriggerLogGroup,
        });

        documentAnalysisTrigger.addEventSource(new SqsEventSource(statementUploadQueue, { batchSize: 1 }));
        receiptUploadsBucket.grantRead(documentAnalysisTrigger);
        documentAnalysisTrigger.addToRolePolicy(new PolicyStatement({
            actions: ['textract:StartDocumentAnalysis'],
            resources: ['*'],
        }));

        // Lambda: triggered by Textract completion via SNS -> SQS, processes results
        const documentAnalysisProcessorLogGroup = new logs.LogGroup(this, 'document-analysis-processor-logs', {
            logGroupName: '/aws/lambda/document-analysis-processor',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const documentAnalysisProcessor = new Function(this, 'document-analysis-processor', {
            functionName: 'document-analysis-processor',
            code: Code.fromBucket(props.rustArtifactBucket, artifactKeys.get(DOCUMENT_ANALYSIS_PROCESSOR_S3_KEY_PARAM_NAME)!.valueAsString),
            runtime: Runtime.PROVIDED_AL2023,
            architecture: Architecture.ARM_64,
            handler: 'does_not_matter',
            timeout: cdk.Duration.seconds(60),
            environment: {
                EXPENSES_TABLE_NAME: expensesTable.tableName,
            },
            logGroup: documentAnalysisProcessorLogGroup,
        });

        documentAnalysisProcessor.addEventSource(new SqsEventSource(textractCompletionQueue, { batchSize: 1 }));

        const documentAnalysisProcessorLocalDevRole = new Role(this, 'document-analysis-processor-local-dev-role', {
            roleName: 'documentAnalysisProcessorLocalDevRole',
            assumedBy: new AccountRootPrincipal(),
            description: 'Role for local testing with same permissions as document-analysis-processor Lambda',
        });

        const grantDocumentAnalysisProcessorPermissions = (grantables: IGrantable[]) => {
            grantables.forEach(grantable => {
                grantable.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
                    actions: ['textract:GetDocumentAnalysis'],
                    resources: ['*'],
                }));
                expensesTable.grantWriteData(grantable);
            });
        };

        grantDocumentAnalysisProcessorPermissions([documentAnalysisProcessor, documentAnalysisProcessorLocalDevRole]);

        documentAnalysisProcessorLocalDevRole.addToPolicy(new PolicyStatement({
            actions: ['lambda:GetFunctionConfiguration'],
            resources: [documentAnalysisProcessor.functionArn],
        }));
    }
}
