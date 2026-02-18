# Siteline AWS CloudFront Lambda@Edge

Automatically track CloudFront traffic (including AI bot visits such as ChatGPT, Claude, and Perplexity) with Lambda@Edge and Siteline.

## Prerequisites
- AWS account with a CloudFront distribution
- Node.js 18+ and npm
- AWS CLI configured with deployment permissions
- `jq` and `zip` installed
- Your Siteline website key

## Installation

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment values**
   ```bash
   cp .env.example .env
   ```
   Set your real `SITELINE_WEBSITE_KEY` in `.env`.

3. **Build and package the Lambda artifact**
   ```bash
   npm run package
   ```

4. **Deploy the Lambda function in us-east-1**
   ```bash
   npm run deploy
   ```

5. **Attach the function to CloudFront viewer-request**
   ```bash
   export DISTRIBUTION_ID=E0000000000000
   export FUNCTION_VERSION_ARN=arn:aws:lambda:us-east-1:123456789012:function:siteline-cloudfront-viewer-request:1
   export EVENT_TYPE=viewer-request
   npm run attach:cloudfront
   ```

6. **Attach the same version to CloudFront viewer-response**
   ```bash
   export EVENT_TYPE=viewer-response
   npm run attach:cloudfront
   ```

7. **Wait for CloudFront deployment propagation**
   CloudFront updates can take several minutes before status becomes `Deployed`.

## What Gets Tracked

The Lambda tracks request/response telemetry as Siteline `PageviewData`:
- `url`
- `method`
- `status` (from CloudFront viewer-response)
- `duration` (elapsed time between viewer-request and viewer-response handler execution)
- `userAgent`
- `ref`
- `ip`

## Configuration

### Update the Lambda
After making code changes:
```bash
npm run package
npm run deploy
```
Then re-attach the newly published version to both event types.

### View logs
Use CloudWatch Logs for the Lambda@Edge function (in `us-east-1` and replicated edge regions). For quick checks:
```bash
aws logs tail "/aws/lambda/us-east-1.siteline-cloudfront-viewer-request" --follow --region us-east-1
```

## How It Works

The Lambda is attached to two CloudFront phases:
1. **viewer-request**: stamps a start timestamp in request headers and passes request through unchanged
2. **viewer-response**: reads response status, computes duration, and calls `siteline.track(...)`
3. Always returns original request/response objects (fail-open behavior on tracking errors)

## Troubleshooting

**No tracking events?**
- Verify `SITELINE_WEBSITE_KEY` is set in packaged `.env`
- Confirm Lambda is attached to **both** `viewer-request` and `viewer-response`
- Check CloudWatch logs for tracking errors
- Verify CloudFront distribution status is `Deployed`

**Need to change your website key?**
- Update `.env`
- Re-run:
  ```bash
  npm run package
  npm run deploy
  ```

## Documentation
- [GitHub Repository](https://github.com/siteline-ai/siteline-aws-cloudfront)

## Support

- [GitHub Issues](https://github.com/siteline-ai/siteline-aws-cloudfront/issues)
- Email: team@siteline.ai
