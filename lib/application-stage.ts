import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WebsiteStack, WebsiteStackProps } from './website-stack';

export interface ApplicationStageProps extends WebsiteStackProps {
}

export class ApplicationStage extends cdk.Stage {
    private websiteStack: WebsiteStack;

    constructor(scope: Construct, id: string, props: ApplicationStageProps) {
        super(scope, id, props);

        this.websiteStack = new WebsiteStack(this, "website-stack", { 
            stackName: "website-stack",
            description: "Infrastructure for website.wbertore.dev website",
            env: props?.env,
            ...props,
        });
    }
}