import { pipelines } from "aws-cdk-lib";
import { IStage } from "aws-cdk-lib/aws-codepipeline";
import { S3DeployAction } from "aws-cdk-lib/aws-codepipeline-actions";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { FileSet } from "aws-cdk-lib/pipelines";
import { BinaryConfig } from "./common";

interface BinaryArtifact {
    binary: BinaryConfig;
    artifactKey: string;
    fileSet: FileSet;
}

// Step that deploys all rust binary artifacts to S3 in a single pipeline action group.
export class DeployRustArtifactsStep extends pipelines.Step implements pipelines.ICodePipelineActionFactory {
    public constructor(private bucket: IBucket, private artifacts: BinaryArtifact[]) {
        super("DeployRustArtifactsStep");
    }

    produceAction(stage: IStage, options: pipelines.ProduceActionOptions): pipelines.CodePipelineActionFactoryResult {
        this.artifacts.forEach(({ binary, artifactKey, fileSet }, i) => {
            stage.addAction(new S3DeployAction({
                actionName: `${options.actionName}-${binary.artifactKeyPrefix.replace(/-$/, '')}`,
                runOrder: options.runOrder + i,
                extract: false,
                objectKey: artifactKey,
                input: options.artifacts.toCodePipeline(fileSet),
                bucket: this.bucket,
            }));
        });

        return { runOrdersConsumed: this.artifacts.length };
    }
}
