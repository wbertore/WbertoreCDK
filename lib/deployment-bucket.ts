import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Function, IFunction, Runtime, Code } from 'aws-cdk-lib/aws-lambda';

export class DeploymentBucket extends Bucket {
    public readonly cleanupFunction: IFunction;

    constructor(scope: Construct, id: string, bucketName: string) {
        super(scope, id, { bucketName });

        this.cleanupFunction = new Function(scope, `${id}-cleanup`, {
            runtime: Runtime.NODEJS_22_X,
            handler: "index.handler",
            timeout: cdk.Duration.seconds(30),
            environment: { BUCKET_NAME: bucketName },
            code: Code.fromInline(`
                const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
                const { CodePipelineClient, PutJobSuccessResultCommand, PutJobFailureResultCommand } = require("@aws-sdk/client-codepipeline");
                const s3 = new S3Client();
                const cp = new CodePipelineClient();
                exports.handler = async (event) => {
                    const jobId = event["CodePipeline.job"].id;
                    try {
                        const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: process.env.BUCKET_NAME }));
                        const sorted = Contents.sort((a, b) => b.LastModified - a.LastModified);
                        const toRetain = sorted.slice(0, 3);
                        const toDelete = sorted.slice(3);
                        console.log("Retaining:", toRetain.map(o => o.Key));
                        console.log("Deleting:", toDelete.map(o => o.Key));
                        if (toDelete.length) {
                            await s3.send(new DeleteObjectsCommand({
                                Bucket: process.env.BUCKET_NAME,
                                Delete: { Objects: toDelete.map(o => ({ Key: o.Key })) }
                            }));
                        }
                        await cp.send(new PutJobSuccessResultCommand({ jobId }));
                    } catch (err) {
                        await cp.send(new PutJobFailureResultCommand({
                            jobId,
                            failureDetails: { type: "JobFailed", message: String(err) }
                        }));
                    }
                };
            `),
        });
        this.grantReadWrite(this.cleanupFunction);
    }
}
