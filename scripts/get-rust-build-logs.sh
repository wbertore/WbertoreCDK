#!/bin/bash
set -e

PROFILE="wbertore-admin"
REGION="us-west-2"

echo "Fetching latest Pipeline execution..."
EXECUTION_ID=$(aws codepipeline list-pipeline-executions \
  --pipeline-name Pipeline \
  --max-items 1 \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'pipelineExecutionSummaries[0].pipelineExecutionId' \
  --output json | tr -d '"')

echo "Latest execution: $EXECUTION_ID"

echo "Finding rust-build-step CodeBuild ID..."
ACTION_EXECUTION_ID=$(aws codepipeline list-action-executions \
  --pipeline-name Pipeline \
  --filter pipelineExecutionId="$EXECUTION_ID" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'actionExecutionDetails[?actionName==`rust-build-step`] | [0].output.executionResult.externalExecutionId' \
  --output text)

echo "CodeBuild execution: $ACTION_EXECUTION_ID"

echo "Fetching logs..."
LOG_STREAM=$(aws codebuild batch-get-builds \
  --ids "$ACTION_EXECUTION_ID" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'builds[0].logs.streamName' \
  --output text)

LOG_GROUP=$(aws codebuild batch-get-builds \
  --ids "$ACTION_EXECUTION_ID" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'builds[0].logs.groupName' \
  --output text)

echo "Log: $LOG_GROUP/$LOG_STREAM"
echo "---"

aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "$LOG_STREAM" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'events[-100:].message' \
  --output text
