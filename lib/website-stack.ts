import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Architecture, Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { IBucket } from 'aws-cdk-lib/aws-s3';

export interface WebsiteStackProps extends cdk.StackProps {
    rustArtifactBucket: IBucket,
    rustArtifactKey: string,
}

export class WebsiteStack extends cdk.Stack {
    private websiteBackend: Function;
    constructor(scope: Construct, id: string, props: WebsiteStackProps) {
        super(scope, id, props);
        const websiteBackend = new Function(this, "website-backend", {
            code: Code.fromBucket(props.rustArtifactBucket, props.rustArtifactKey),
            runtime: Runtime.PROVIDED_AL2,
            architecture: Architecture.ARM_64,
            timeout: cdk.Duration.seconds(60),
            // HUH???? apparently other people are doing this:
            // https://medium.com/techhappily/rust-based-aws-lambda-with-aws-cdk-deployment-14a9a8652d62
            handler: "does_not_matter",
            functionName: "website-backend",
        });

        // APIGateway will need this eventually.
        /* const websiteBackendAlias = new Alias(this, "website-backend-alias", {
            aliasName: "live",
            version: websiteBackend.currentVersion
        });*/
    }
}