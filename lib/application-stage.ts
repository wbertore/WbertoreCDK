import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WebsiteStack, WebsiteStackProps } from './website-stack';
import { ExpenseStack } from './expense-stack';
import { IBucket } from 'aws-cdk-lib/aws-s3';

export interface ApplicationStageProps extends cdk.StageProps {
    rustArtifactBucket: IBucket;
}

export class ApplicationStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props: ApplicationStageProps) {
        super(scope, id, props);

        const expenseStack = new ExpenseStack(this, "expense-stack", {
            stackName: "expense-stack",
            description: "Infrastructure for expense tracking",
            rustArtifactBucket: props.rustArtifactBucket,
        });

        const websiteStack = new WebsiteStack(this, "website-stack", {
            stackName: "website-stack",
            description: "Infrastructure for website.wbertore.dev website",
            rustArtifactBucket: props.rustArtifactBucket,
        });
        websiteStack.addDependency(expenseStack);
    }
}
