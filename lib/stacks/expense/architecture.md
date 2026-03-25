# Expense Stack Architecture

## Overview

This stack processes receipt images uploaded by users, extracts line-item data via AWS Textract, and uses Claude Haiku to categorize each expense. Results are persisted to DynamoDB.

## Data Flow

```
User uploads receipt
       │
       ▼
S3 (receipt-uploads)
       │  S3 ObjectCreated event
       ▼
SQS (receipt-upload-queue)
       │  batch size: 10
       ▼
Lambda (expense-processor)
       │
       ├──► Textract (AnalyzeExpense) ──► extracts line items from receipt image
       │
       ├──► Bedrock / Claude Haiku ──► categorizes each line item
       │
       └──► DynamoDB (expenses) ──► stores categorized expense records
```

## Infrastructure

| Resource | Name | Notes |
|---|---|---|
| S3 Bucket | receipt-uploads | CORS enabled for PUT from wbertore.dev and localhost. 14-day lifecycle expiration. |
| SQS Queue | receipt-upload-queue | 60s visibility timeout. DLQ after 3 failures. |
| Lambda | expense-processor | ARM64, AL2023, 60s timeout. Triggered by SQS. |
| DynamoDB | expenses | PK + SK (both String). Pay-per-request billing. |

## DynamoDB Schema

| Attribute | Type | Description |
|---|---|---|
| PK | String | User identifier |
| SK | String | Receipt + line item composite key |

For the full table schema and expense categories, see [`WbertoreRustLambdas/src/expense-processor/expenses_dao.rs`](https://github.com/wbertore/WbertoreRustLambdas/tree/main/src/expense-processor/expenses_dao.rs).
