# WbertoreCDK
Infrastructure as code project for infrastructure in personal aws account

## Pre-requisites
1. Install cdk: `brew install aws-cdk`
2. node: `brew install node`

## Building locally
Run the following command to build and format the project:
```bash
npm run build
```

Run the following command to verify the app synthesizes and spits out a cloudformation template
```
npm run cdk synthesize
```