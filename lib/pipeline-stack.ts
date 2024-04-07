import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CodeBuildStep, CodePipeline, CodePipelineSource, FileSet, ShellStep, Wave } from 'aws-cdk-lib/pipelines';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { DeployRustArtifactsStep } from './deploy-rust-artifacts-step';
import { ApplicationStage } from './application-stage';

export class PipelineStack extends cdk.Stack {  
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // The secret we manually configured in aws secrets manager that has the private key from github.com for my account.
    const githubSecret = cdk.SecretValue.secretsManager('github-access-token-codepipeline');
    const rustLambdasSource = CodePipelineSource.gitHub('wbertore/WbertoreRustLambdas', 'main', {
      authentication: githubSecret,
    });

    // self mutating build step
    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'Pipeline',
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.gitHub('wbertore/WbertoreCDK', 'main', {
          authentication: githubSecret,
        }),
        // add rust lambdas as an additional source. We're just using this as a trigger and re-pulling it in the wave step below.
        additionalInputs: {
          "../WbertoreRustLambdas": rustLambdasSource
        },
        commands: ['npm ci', 'npm run build', 'npx cdk synth']
      }),
    });
    const rustArtifactBucket = new Bucket(this, "rust-artifacts-bucket", {
      bucketName: "rust-artifacts"
    });
    
    const buildWave = pipeline.addWave("rust-build");
    const rustBuildFileSet = this.addCodeBuildStep(buildWave, rustLambdasSource);

    const deployWave = pipeline.addWave("deploy-rust-artifact");
    const rustArtifactKey = this.addDeployRustArtifactsStep(deployWave, rustLambdasSource, rustBuildFileSet, rustArtifactBucket);
    
    const applicationStage = new ApplicationStage(this, "website-prod", {
      rustArtifactBucket,
      rustArtifactKey,
    })
    pipeline.addStage(applicationStage)
  };

  addCodeBuildStep(
    wave: Wave, 
    rustLambdasSource: cdk.pipelines.CodePipelineSource,
  ): FileSet {
    const zigFolderPrefix = "zig-linux-x86_64"
    const zigVersion = `${zigFolderPrefix}-0.12.0-dev.3539+23f729aec`;
    const rustCodeBuildStep = new CodeBuildStep("rust-build-step", {
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
        "cargo binstall -y cargo-lambda", 
        // Install zig, which is a dependency of cargo-lambda
        "curl --proto '=https' --tlsv1.2 -sSf https://ziglang.org/builds/" + zigVersion + ".tar.xz | tar -x -J",
        // To avoid invalid characters in PATH, rename the folder. Then add the shortened folder to the PATH.
        "mv './" + zigVersion + "' ./" + zigFolderPrefix,
        "export PATH=$PATH:$(pwd -P)/'" + zigFolderPrefix + "'",
        // Add the arm64 Al2 Linux target. copied from a local build error trying to run the command.
        "rustup target add aarch64-unknown-linux-gnu"
      ],
      // https://github.com/awslabs/aws-lambda-rust-runtime?tab=readme-ov-file#12-build-your-lambda-functions
      // For now this is outputting a 17.3 MB zip file. If it breaches 50MB we'll need to offload this to s3 and give Lambda a pointer to s3.
      commands: [
        "cargo test",
        "cargo lambda build --release --arm64 --output-format zip"
      ],
      input: rustLambdasSource,
      // TODO this is eventually going to be a tree where each entry point has a different parent.
      // ./target/lambda/
      //                | my-rust-lambda-1/bootstrap.zip
      //                | my-rust-lambda-2/bootstrap.zip
      // This is the primary output of the step. In theory we can reference this in other steps...
      primaryOutputDirectory: "./target/lambda/WbertoreRustLambdas",
    });

    wave.addPre(rustCodeBuildStep);
    // we should only have 1 output.
    return rustCodeBuildStep.outputs[0].fileSet
  }

  addDeployRustArtifactsStep(
    wave: Wave, 
    rustLambdasSource: cdk.pipelines.CodePipelineSource, 
    rustBuildFileSet: FileSet, 
    rustArtifactBucket: IBucket
  ): string {
    // Source attribute should update on each commit. We need to pass this to our lambda
    const rustArtifactKey = `bootstrap-${rustLambdasSource.sourceAttribute}.zip`
    wave.addPre(new DeployRustArtifactsStep(
      rustArtifactBucket, 
      rustArtifactKey, 
      rustBuildFileSet,
    ));
    return rustArtifactKey;
  }
}