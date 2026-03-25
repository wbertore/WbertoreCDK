import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CodeBuildStep, CodePipeline, CodePipelineSource, FileSet, ShellStep, Wave } from 'aws-cdk-lib/pipelines';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { DeployRustArtifactsStep } from './deploy-rust-artifacts-step';
import { ApplicationStage } from './application-stage';
import { GlobalVariables } from 'aws-cdk-lib/aws-codepipeline';
import { BINARIES, buildArtifactKey } from '../../constants';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { DeploymentBucket } from './deployment-bucket';
import { CleanupArtifactsStep } from './cleanup-artifacts-step';

export class PipelineStack extends cdk.Stack {  
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const connectionArn = 'arn:aws:codestar-connections:us-west-2:042589243248:connection/cff65188-1a93-4e33-a0f9-f433cff4d5c0';
    
    const rustLambdasSource = CodePipelineSource.connection('wbertore/WbertoreRustLambdas', 'main', {
      connectionArn,
    });

    // self mutating build step
    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'Pipeline',
      synthCodeBuildDefaults: {
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          phases: { install: { 'runtime-versions': { nodejs: 22 } } }
        }),
      },
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.connection('wbertore/WbertoreCDK', 'main', {
          connectionArn,
        }),
        // HACK: Force codepipelines to resolve this:
        // https://github.com/aws/aws-cdk/issues/20643
        env: {
          RUST_LAMBDAS_SOURCE_COMMIT_ID: rustLambdasSource.sourceAttribute('CommitId')
        },
        // add rust lambdas as an additional source. We're just using this as a trigger and re-pulling it in the wave step below.
        additionalInputs: {
          "../WbertoreRustLambdas": rustLambdasSource
        },
        commands: ['npm ci', 'npm run build', 'npx cdk synth']
      }),
    });

    const rustArtifactBucket = new DeploymentBucket(this, "rust-artifacts-bucket", "wbertore-website-rust-artifacts");
    const buildCacheBucket = new s3.Bucket(this, "rust-build-cache-bucket", {
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    // Artifact keys keyed by outputDir for lookup throughout the pipeline
    const artifactKeys = new Map<string, string>(
      BINARIES.map(b => [b.outputDir, buildArtifactKey(b.artifactKeyPrefix, GlobalVariables.executionId)])
    );

    const buildWave = pipeline.addWave("rust-build");
    const fileSets = this.addCodeBuildStep(buildWave, rustLambdasSource, buildCacheBucket);

    const deployWave = pipeline.addWave("deploy-rust-artifact");
    deployWave.addPre(new DeployRustArtifactsStep(
      rustArtifactBucket,
      BINARIES.map(b => ({
        binary: b,
        artifactKey: artifactKeys.get(b.outputDir)!,
        fileSet: fileSets.get(b.outputDir)!,
      })),
    ));
    deployWave.addPost(new CleanupArtifactsStep(rustArtifactBucket.cleanupFunction));
    
    const applicationStage = new ApplicationStage(this, "website-prod", {
      rustArtifactBucket,
    });

    pipeline.addStage(applicationStage);

    // HACK: We need to build the pipeline to mutate the inner structure to inject a cloudformation parameter
    pipeline.buildPipeline();
    this.applyParameterOverrides(pipeline, applicationStage, artifactKeys);
  };

  addCodeBuildStep(
    wave: Wave, 
    rustLambdasSource: cdk.pipelines.CodePipelineSource,
    buildCacheBucket: IBucket,
  ): Map<string, FileSet> {
    const [primary, ...rest] = BINARIES;

    const rustCodeBuildStep = new CodeBuildStep("rust-build-step", {
      buildEnvironment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_ARM_3,
        computeType: codebuild.ComputeType.SMALL,
      },
      installCommands: [
        // Install rustup: https://forge.rust-lang.org/infra/other-installation-methods.html#other-ways-to-install-rustup
        // `--` stops option processing on `sh` so `-` is passed to the downloaded and invoked script.
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
        ". $HOME/.cargo/env", 
        // Install cargo binstall, so we can pull down a pre-compiled binary instead of compiling cargo-lambda from
        // source. Apparently compiling from source takes like 10 minutes: 
        // https://www.cargo-lambda.info/guide/installation.html#building-from-source
        // https://github.com/cargo-bins/cargo-binstall?tab=readme-ov-file#linux-and-macos
        "curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash",
        // Pull down pre-compiled binary for building rust lambdas: https://www.cargo-lambda.info/guide/installation.html#binary-releases
        // `-y` to auto-accept the install confirmation prompt
        // Skip install if cargo-lambda is already present in the S3 cache from a previous build.
        "command -v cargo-lambda || cargo binstall -y cargo-lambda"
      ],
      // https://github.com/awslabs/aws-lambda-rust-runtime?tab=readme-ov-file#12-build-your-lambda-functions
      // Building natively on AL2023 ARM64 to match Lambda runtime, avoiding cross-compilation and zig
      commands: [
        "pwd && ls target/release/deps 2>/dev/null | wc -l || echo 'no deps cache'",
        "ls target/release/.fingerprint 2>/dev/null | head -1 | xargs -I{} cat target/release/.fingerprint/{}/dep-bin-* 2>/dev/null || echo 'no fingerprint'",
        "cargo lambda build --release --compiler cargo"
      ],
      input: rustLambdasSource,
      primaryOutputDirectory: primary.outputDir,
      cache: codebuild.Cache.bucket(buildCacheBucket),
      partialBuildSpec: codebuild.BuildSpec.fromObject({
        cache: {
          paths: [
            "/root/.cargo/bin/cargo-lambda",
            "target/release/.fingerprint/**/*",
            "target/release/build/**/*",
            "target/release/deps/**/*"
          ]
        }
      })
    });

    const fileSets = new Map<string, FileSet>();
    fileSets.set(primary.outputDir, rustCodeBuildStep.outputs[0].fileSet);
    for (const binary of rest) {
      fileSets.set(binary.outputDir, rustCodeBuildStep.addOutputDirectory(binary.outputDir));
    }

    wave.addPre(rustCodeBuildStep);
    return fileSets;
  }

  // HACK: Allows us to set parameterOverrides for stages in our app.
  // following example on stack overflow
  // https://stackoverflow.com/questions/76391190/use-aws-codepipeline-variables-in-a-custom-stage
  applyParameterOverrides(codepipeline: CodePipeline, stage: cdk.Stage, artifactKeys: Map<string, string>) {
    // Group parameters by stackName so each stack's action gets one merged write
    const byStack = BINARIES.reduce((acc, binary) => {
      const params = acc.get(binary.stackName) ?? {};
      params[binary.parameterName] = artifactKeys.get(binary.outputDir)!;
      return acc.set(binary.stackName, params);
    }, new Map<string, Record<string, string>>());

    const deployIdx = codepipeline.pipeline.stages.indexOf(codepipeline.pipeline.stage(stage.stageName));
    const cfnPipeline = codepipeline.pipeline.node.findChild('Resource') as cdk.aws_codepipeline.CfnPipeline;
    const actionsIdxs = codepipeline.pipeline.stage(stage.stageName).actions
      .filter(x => x.actionProperties.category === 'Deploy')
      .map((x, i) => ({ i, actionName: x.actionProperties.actionName }));

    for (const { i, actionName } of actionsIdxs) {
      const stackName = [...byStack.keys()].find(s => actionName.includes(s));
      if (!stackName) continue;
      cfnPipeline.addOverride(
        `Properties.Stages.${deployIdx}.Actions.${i}.Configuration.ParameterOverrides`,
        JSON.stringify(byStack.get(stackName))
      );
    }
  }
}
