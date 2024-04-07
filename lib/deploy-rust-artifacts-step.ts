import { pipelines } from "aws-cdk-lib";
import { IStage } from "aws-cdk-lib/aws-codepipeline";
import { S3DeployAction } from "aws-cdk-lib/aws-codepipeline-actions";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { FileSet } from "aws-cdk-lib/pipelines";

// Step that deploys a rust artifact to s3 for a given bucket and object key.
export class DeployRustArtifactsStep extends pipelines.Step implements pipelines.ICodePipelineActionFactory {
    public constructor(private bucket: IBucket, private objectKey: string, private readonly input: FileSet) {
        super("DeployRustArtifactsStep");
    }

    produceAction(stage: IStage, options: pipelines.ProduceActionOptions): pipelines.CodePipelineActionFactoryResult {
        stage.addAction(new S3DeployAction({
            actionName: options.actionName,
            runOrder: options.runOrder,
            extract: false,
            // This is the thing we need to track for aliasing our website function.
            objectKey: this.objectKey,
            input: options.artifacts.toCodePipeline(this.input),
            bucket: this.bucket,
        }));

        return { runOrdersConsumed: 1 }
    }
}