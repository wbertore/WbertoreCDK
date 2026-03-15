import { pipelines } from "aws-cdk-lib";
import { IStage } from "aws-cdk-lib/aws-codepipeline";
import { LambdaInvokeAction } from "aws-cdk-lib/aws-codepipeline-actions";
import { IFunction } from "aws-cdk-lib/aws-lambda";

export class CleanupArtifactsStep extends pipelines.Step implements pipelines.ICodePipelineActionFactory {
    public constructor(private readonly cleanupFunction: IFunction) {
        super("CleanupArtifactsStep");
    }

    produceAction(stage: IStage, options: pipelines.ProduceActionOptions): pipelines.CodePipelineActionFactoryResult {
        stage.addAction(new LambdaInvokeAction({
            actionName: options.actionName,
            runOrder: options.runOrder,
            lambda: this.cleanupFunction,
        }));

        return { runOrdersConsumed: 1 };
    }
}
