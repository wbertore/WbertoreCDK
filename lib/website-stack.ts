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
            target: RecordTarget.fromAlias(new ApiGatewayv2DomainProperties(websiteDomain.regionalDomainName, websiteDomain.regionalHostedZoneId))
        });
    }
}