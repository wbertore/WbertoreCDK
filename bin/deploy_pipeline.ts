#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PipelineStack } from '../lib/pipeline-stack';
import { ACCOUNT_ID, REGION } from '../lib/constants';

const app = new cdk.App();
new PipelineStack(app, 'PipelineStack', {
  env: {
    account: ACCOUNT_ID,
    region: REGION,
  }
});

app.synth();
