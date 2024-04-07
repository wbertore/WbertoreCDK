import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Architecture, Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { RUST_ARTIFACT_S3_KEY_PARAM_NAME } from './common';

export interface WebsiteStackProps extends cdk.StackProps {
    rustArtifactBucket: IBucket,
    rustArtifactKey: string,
}

export class WebsiteStack extends cdk.Stack {
    private websiteBackend: Function;
    constructor(scope: Construct, id: string, props: WebsiteStackProps) {
        super(scope, id, props);
        // HACK: retrieve the runtime artifact key from the stack parameter overide we set
        // in the pipeline. 
        const rustArtifactKey = new cdk.CfnParameter(this, RUST_ARTIFACT_S3_KEY_PARAM_NAME);
        const websiteBackend = new Function(this, "website-backend", {
            code: Code.fromBucket(props.rustArtifactBucket, rustArtifactKey.valueAsString),
            // As of 2024-04-07, the rust bootstrap requires GLIBC_2.28. AL2 has too old of a version.
            // Try using AL2023:
            // https://docs.aws.amazon.com/linux/al2023/ug/compare-with-al2.html#glibc-gcc-and-binutils
            runtime: Runtime.PROVIDED_AL2023,
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