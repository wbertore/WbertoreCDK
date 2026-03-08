#!/bin/bash
set -e

PROFILE="wbertore-admin"
REGION="us-west-2"
FUNCTION_NAME="website-backend"
LOG_GROUP="/aws/lambda/$FUNCTION_NAME"

# Get number of lines to fetch (default 100)
LINES=${1:-100}

echo "Fetching last $LINES lines from $FUNCTION_NAME Lambda logs..."

# Get the most recent log stream
LOG_STREAM=$(aws logs describe-log-streams \
  --log-group-name "$LOG_GROUP" \
  --order-by LastEventTime \
  --descending \
  --max-items 1 \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query 'logStreams[0].logStreamName' \
  --output json | tr -d '"')

if [ -z "$LOG_STREAM" ] || [ "$LOG_STREAM" = "null" ]; then
  echo "Error: No log streams found for $FUNCTION_NAME"
  exit 1
fi

echo "Latest log stream: $LOG_STREAM"
echo "---"

# Get logs and tail last N lines
aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "$LOG_STREAM" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query "events[-${LINES}:].message" \
  --output text
