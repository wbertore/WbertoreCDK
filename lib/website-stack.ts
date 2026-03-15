import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Alias, Architecture, Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { RUST_ARTIFACT_S3_KEY_PARAM_NAME } from './common';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiMapping, DomainName, EndpointType, HttpApi, HttpMethod, HttpNoneAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { ApiGatewayv2DomainProperties } from 'aws-cdk-lib/aws-route53-targets';
import { UserPool, UserPoolClient, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { PolicyStatement, Role, AccountRootPrincipal, ManagedPolicy, IGrantable } from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface WebsiteStackProps extends cdk.StackProps {
    rustArtifactBucket: IBucket,
    rustArtifactKey: string,
}

const ROOT_DOMAIN = "wbertore.dev"
const WEBSITE_DOMAIN = `website.${ROOT_DOMAIN}`

export class WebsiteStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: WebsiteStackProps) {
        super(scope, id, props);
        // HACK: retrieve the runtime artifact key from the stack parameter overide we set
        // in the pipeline. 
        const rustArtifactKey = new cdk.CfnParameter(this, RUST_ARTIFACT_S3_KEY_PARAM_NAME);
        // Cognito User Pool for authentication
        const userPool = new UserPool(this, "website-user-pool", {
            userPoolName: "website-users",
            selfSignUpEnabled: false,
            signInAliases: { email: true },
            autoVerify: { email: true },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            userInvitation: {
                emailSubject: 'You have been invited to wbertore.dev',
                emailBody: 'Hello {username},<br><br>You have been invited to access wbertore.dev.<br><br>Your temporary password is: {####}<br><br>Please login at: https://website.wbertore.dev/auth/dashboard',
            },
        });

        const userPoolClient = new UserPoolClient(this, "website-user-pool-client", {
            userPool,
            authFlows: { userPassword: true, userSrp: true },
            generateSecret: true,
            oAuth: {
                flows: { authorizationCodeGrant: true },
                scopes: [{ scopeName: "openid" }, { scopeName: "email" }, { scopeName: "profile" }],
                callbackUrls: [
                    `https://${WEBSITE_DOMAIN}/oauth2/idpresponse`,
                    'https://localhost:9000/oauth2/idpresponse'
                ]
            }
        });

        const userPoolDomain = new UserPoolDomain(this, "website-user-pool-domain", {
            userPool,
            cognitoDomain: { domainPrefix: "wbertore-website" }
        });

        const csrfKey = new kms.Key(this, "csrf-key", {
            description: "HMAC key for CSRF token signing",
            keySpec: kms.KeySpec.HMAC_256,
            keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const websiteBackendLogGroup = new logs.LogGroup(this, "website-backend-logs", {
            logGroupName: "/aws/lambda/website-backend",
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const websiteBackend = new Function(this, "website-backend", {
            code: Code.fromBucket(props.rustArtifactBucket, rustArtifactKey.valueAsString),
            runtime: Runtime.PROVIDED_AL2023,
            architecture: Architecture.ARM_64,
            timeout: cdk.Duration.seconds(60),
            handler: "does_not_matter",
            functionName: "website-backend",
            environment: {
                COGNITO_USER_POOL_ID: userPool.userPoolId,
                COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
                COGNITO_USER_POOL_DOMAIN: userPoolDomain.domainName,
                COGNITO_REGION: this.region,
                AUTH_DOMAIN: WEBSITE_DOMAIN,
                CSRF_KMS_KEY_ID: csrfKey.keyId,
                RUST_LOG: "debug",
                RUST_BACKTRACE: "1",
                AWS_LAMBDA_LOG_LEVEL: "DEBUG",
                CODE_VERSION: rustArtifactKey.valueAsString,
            },
            logGroup: websiteBackendLogGroup,
        });
        // Safe to suppress: rustArtifactKey is dynamic, so Lambda updates are triggered by key changes
        websiteBackend.node.addMetadata('aws:cdk:warning:suppress', [
            '@aws-cdk/aws-lambda:codeFromBucketObjectVersionNotSpecified'
        ]);

        const localDevRole = new Role(this, "localDevRole", {
            roleName: "localDevRole",
            assumedBy: new AccountRootPrincipal(),
            description: "Role for local testing with same permissions as website-backend Lambda"
        });

        // Grant permissions to both Lambda and local dev role
        const grantWebsiteBackendPermissions = (grantables: IGrantable[]) => {
            grantables.forEach(grantable => {
                grantable.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({
                    actions: ['cognito-idp:DescribeUserPoolClient'],
                    resources: [userPool.userPoolArn]
                }));
                csrfKey.grant(grantable, 'kms:GenerateMac', 'kms:VerifyMac');
            });
        };

        grantWebsiteBackendPermissions([websiteBackend, localDevRole]);
        
        // Grant local dev role permission to read Lambda config (for local-server.sh)
        localDevRole.addToPolicy(new PolicyStatement({
            actions: ['lambda:GetFunctionConfiguration'],
            resources: [websiteBackend.functionArn]
        }));

        const websiteBackendAlias = new Alias(this, "website-backend-alias", {
            aliasName: "live",
            version: websiteBackend.currentVersion
        });

        const lambdaIntegration = new HttpLambdaIntegration("website-backend-integration", websiteBackendAlias);

        const websiteApi = new HttpApi(this, "website-api", {
            apiName: "WebsiteApi",
            defaultAuthorizer: new HttpNoneAuthorizer(),
        });
        websiteApi.addRoutes({
            path: '/{proxy+}',
            integration: lambdaIntegration,
            methods: [HttpMethod.ANY],
            authorizer: new HttpNoneAuthorizer()
        });

        // This is our manually created hosted zone. I would normally delegate to a new zone for a subdomain, but I
        // want to stay in the free tier for my personal aws account.
        const rootHostedZone = HostedZone.fromHostedZoneAttributes(this, "wbertore-dev", {
           hostedZoneId: "Z0030825281KMXOW1FSJP",
           zoneName: ROOT_DOMAIN
        });

        const certificate = new Certificate(this, "website-certificate", {
            domainName: WEBSITE_DOMAIN,
            validation: CertificateValidation.fromDns(rootHostedZone)
        });

        const websiteDomain = new DomainName(this, 'website-domain', {
            domainName: WEBSITE_DOMAIN,
            certificate: certificate,
            endpointType: EndpointType.REGIONAL
        });
        const websiteMapping = new ApiMapping(this, "website-api-mapping", {
            api: websiteApi,
            domainName: websiteDomain,
            stage: websiteApi.defaultStage
        });
        const websiteARecord = new ARecord(this, "website-a-record", {
            zone: rootHostedZone,
            recordName: WEBSITE_DOMAIN,
            target: RecordTarget.fromAlias(new ApiGatewayv2DomainProperties(websiteDomain.regionalDomainName, websiteDomain.regionalHostedZoneId))
        });

        new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
        new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
        new cdk.CfnOutput(this, "UserPoolRegion", { value: this.region });
        new cdk.CfnOutput(this, "CognitoLoginUrl", { 
            value: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com/login?client_id=${userPoolClient.userPoolClientId}&response_type=code&redirect_uri=https://${WEBSITE_DOMAIN}/oauth2/idpresponse`
        });
    }
}