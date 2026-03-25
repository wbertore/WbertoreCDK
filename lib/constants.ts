export const ACCOUNT_ID = '042589243248';
export const REGION = 'us-west-2';

import * as cdk from 'aws-cdk-lib';

export const WEBSITE_BACKEND_S3_KEY_PARAM_NAME = "rustartifacts3key";
export const EXPENSE_PROCESSOR_ARTIFACT_S3_KEY_PARAM_NAME = "expenseprocessors3key";

export interface BinaryConfig {
    // Path to the cargo lambda build output, e.g. "./target/lambda/website-backend"
    outputDir: string;
    // S3 key prefix used for artifact storage and cleanup grouping, e.g. "website-backend-"
    artifactKeyPrefix: string;
    // CloudFormation stack name that receives this binary
    stackName: string;
    // CfnParameter name declared in that stack
    parameterName: string;
}

export const BINARIES: BinaryConfig[] = [
    {
        outputDir: "./target/lambda/website-backend",
        artifactKeyPrefix: "website-backend-",
        stackName: "website-stack",
        parameterName: WEBSITE_BACKEND_S3_KEY_PARAM_NAME,
    },
    {
        outputDir: "./target/lambda/expense-processor",
        artifactKeyPrefix: "expense-processor-",
        stackName: "expense-stack",
        parameterName: EXPENSE_PROCESSOR_ARTIFACT_S3_KEY_PARAM_NAME,
    },
];

export function buildArtifactKey(prefix: string, executionId: string) {
    return `${prefix}${executionId}`;
}

// Returns a map of parameterName -> CfnParameter for all binaries targeting the given stack.
export function resolveArtifactKeyParams(scope: cdk.Stack, stackName: string): Map<string, cdk.CfnParameter> {
    return new Map(
        BINARIES
            .filter(b => b.stackName === stackName)
            .map(b => [b.parameterName, new cdk.CfnParameter(scope, b.parameterName)])
    );
}