# Siteline AWS CloudFront S3 Log Processor

This project tracks CloudFront traffic with Siteline.
It processes CloudFront standard access logs from S3.
It forwards pageview events to the Siteline API.

## Architecture

```text
Existing CloudFront distribution
  -> Standard access logs to S3
  -> EventBridge (Object Created)
  -> Lambda log processor (this project)
  -> Siteline API
```

## Prerequisites

- Node.js 18+ and npm
- AWS CLI v2
- `jq`
- `zip`
- Existing CloudFront distribution configured to write standard logs to S3
- IAM permissions for `s3`, `lambda`, `iam`, and `events` management

## AWS CLI Login

Use one of the following methods.

### Option 1: Access keys

```bash
aws configure
aws sts get-caller-identity
```

### Option 2: AWS SSO

```bash
aws configure sso
aws sso login --profile <your-profile>
aws sts get-caller-identity --profile <your-profile>
```

If you use SSO, set `AWS_PROFILE` in `.env`.

## Configuration

```bash
cp .env.example .env
```

Set at least:

- `SITELINE_WEBSITE_KEY`
- `LOG_BUCKET_NAME`
- `AWS_REGION`
- `AWS_PROFILE` (if used)

## Setup Scripts

The scripts are idempotent.
They reuse existing resources when safe.
They stop on errors.

- `scripts/setup-s3.sh`  
Creates/configures the S3 log bucket.  
Enables S3 -> EventBridge notifications.

- `scripts/setup-lambda.sh`  
Creates/updates IAM role and Lambda.  
Deploys the packaged function.

- `scripts/setup-eventbridge.sh`  
Creates the EventBridge rule.  
Adds Lambda invoke permission.  
Links S3 object-created events to Lambda.

- `scripts/setup-all.sh`  
Runs all setup scripts in order.

Run via npm:

```bash
npm run setup:s3
npm run setup:lambda
npm run setup:eventbridge
npm run setup:all
```

## Deployment Flow

1. Install dependencies.

```bash
npm install
```

2. Build and package Lambda.

```bash
npm run package
```

3. Provision AWS resources.

```bash
npm run setup:all
```

4. Confirm CloudFront writes logs to `LOG_BUCKET_NAME`.

For CI, disable prompts:

```bash
export AUTO_APPROVE=true
```

## Validation

Run local quality checks:

```bash
npm run ci
```

## Runtime Mapping

The processor reads CloudFront `#Fields` dynamically.
It maps:

- `url` from `cs-host`, `cs-uri-stem`, `cs-uri-query`
- `method` from `cs-method`
- `status` from `sc-status`
- `duration` from `time-taken * 1000`
- `userAgent` from decoded `cs(User-Agent)`
- `ref` from `cs(Referer)`
- `ip` from `c-ip`

Invalid rows are skipped.
Rows with invalid status or missing URI are ignored.

## Debugging Tips

Check caller identity:

```bash
aws sts get-caller-identity --region "${AWS_REGION}"
```

Tail Lambda logs:

```bash
aws logs tail "/aws/lambda/${LAMBDA_FUNCTION_NAME}" --follow --region "${AWS_REGION}"
```

Inspect EventBridge targets:

```bash
aws events list-targets-by-rule --name "${EVENT_RULE_NAME}" --region "${AWS_REGION}"
```

Common issues:

- `AccessDenied`: missing IAM permissions.
- No invocations: CloudFront is not writing logs to the expected bucket.
- No events: S3 EventBridge notifications are not enabled.

## Operational Notes

- CloudFront standard logs are delayed. Typical delay is 5-15 minutes.
- Costs come from S3 storage, Lambda invocations, and EventBridge events.
