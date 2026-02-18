#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSUME_ROLE_POLICY_FILE="${ROOT_DIR}/config/iam/lambda-edge-assume-role-policy.json"
EXECUTION_POLICY_FILE="${ROOT_DIR}/config/iam/lambda-edge-execution-policy.json"

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-}"
LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-siteline-cloudfront-viewer-request}"
LAMBDA_ROLE_NAME="${LAMBDA_ROLE_NAME:-siteline-cloudfront-edge-role}"
LAMBDA_RUNTIME="${LAMBDA_RUNTIME:-nodejs18.x}"
LAMBDA_HANDLER="${LAMBDA_HANDLER:-index.handler}"
LAMBDA_ARCHITECTURE="${LAMBDA_ARCHITECTURE:-x86_64}"
LAMBDA_TIMEOUT_SECONDS="${LAMBDA_TIMEOUT_SECONDS:-5}"
LAMBDA_MEMORY_MB="${LAMBDA_MEMORY_MB:-128}"
LAMBDA_ZIP_PATH="${LAMBDA_ZIP_PATH:-${ROOT_DIR}/dist/lambda-edge.zip}"

if [[ "${AWS_REGION}" != "us-east-1" ]]; then
  echo "Lambda@Edge functions must be created in us-east-1. Set AWS_REGION=us-east-1." >&2
  exit 1
fi

if [[ ! -f "${LAMBDA_ZIP_PATH}" ]]; then
  echo "Package not found at ${LAMBDA_ZIP_PATH}. Run npm run package first." >&2
  exit 1
fi

AWS_CMD=(aws --region "${AWS_REGION}")
if [[ -n "${AWS_PROFILE}" ]]; then
  AWS_CMD+=(--profile "${AWS_PROFILE}")
fi

echo "Ensuring IAM role ${LAMBDA_ROLE_NAME} exists..."
if ! ROLE_ARN="$("${AWS_CMD[@]}" iam get-role --role-name "${LAMBDA_ROLE_NAME}" --query 'Role.Arn' --output text 2>/dev/null)"; then
  "${AWS_CMD[@]}" iam create-role \
    --role-name "${LAMBDA_ROLE_NAME}" \
    --assume-role-policy-document "file://${ASSUME_ROLE_POLICY_FILE}" >/dev/null

  ROLE_ARN="$("${AWS_CMD[@]}" iam get-role --role-name "${LAMBDA_ROLE_NAME}" --query 'Role.Arn' --output text)"
  echo "Created IAM role: ${ROLE_ARN}"
else
  echo "IAM role already exists: ${ROLE_ARN}"
fi

"${AWS_CMD[@]}" iam put-role-policy \
  --role-name "${LAMBDA_ROLE_NAME}" \
  --policy-name "${LAMBDA_ROLE_NAME}-execution" \
  --policy-document "file://${EXECUTION_POLICY_FILE}" >/dev/null

echo "Ensuring Lambda function ${LAMBDA_FUNCTION_NAME} exists..."
if "${AWS_CMD[@]}" lambda get-function --function-name "${LAMBDA_FUNCTION_NAME}" >/dev/null 2>&1; then
  "${AWS_CMD[@]}" lambda update-function-code \
    --function-name "${LAMBDA_FUNCTION_NAME}" \
    --zip-file "fileb://${LAMBDA_ZIP_PATH}" >/dev/null

  "${AWS_CMD[@]}" lambda wait function-updated --function-name "${LAMBDA_FUNCTION_NAME}"

  "${AWS_CMD[@]}" lambda update-function-configuration \
    --function-name "${LAMBDA_FUNCTION_NAME}" \
    --runtime "${LAMBDA_RUNTIME}" \
    --handler "${LAMBDA_HANDLER}" \
    --role "${ROLE_ARN}" \
    --architectures "${LAMBDA_ARCHITECTURE}" \
    --timeout "${LAMBDA_TIMEOUT_SECONDS}" \
    --memory-size "${LAMBDA_MEMORY_MB}" >/dev/null

  "${AWS_CMD[@]}" lambda wait function-updated --function-name "${LAMBDA_FUNCTION_NAME}"
  echo "Updated existing Lambda function."
else
  "${AWS_CMD[@]}" lambda create-function \
    --function-name "${LAMBDA_FUNCTION_NAME}" \
    --runtime "${LAMBDA_RUNTIME}" \
    --handler "${LAMBDA_HANDLER}" \
    --role "${ROLE_ARN}" \
    --architectures "${LAMBDA_ARCHITECTURE}" \
    --timeout "${LAMBDA_TIMEOUT_SECONDS}" \
    --memory-size "${LAMBDA_MEMORY_MB}" \
    --zip-file "fileb://${LAMBDA_ZIP_PATH}" >/dev/null

  "${AWS_CMD[@]}" lambda wait function-active --function-name "${LAMBDA_FUNCTION_NAME}"
  echo "Created new Lambda function."
fi

PUBLISHED_VERSION="$("${AWS_CMD[@]}" lambda publish-version \
  --function-name "${LAMBDA_FUNCTION_NAME}" \
  --description "Automated deploy $(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --query 'Version' --output text)"

FUNCTION_VERSION_ARN="$("${AWS_CMD[@]}" lambda get-function \
  --function-name "${LAMBDA_FUNCTION_NAME}:${PUBLISHED_VERSION}" \
  --query 'Configuration.FunctionArn' --output text)"

echo "Published Lambda version: ${PUBLISHED_VERSION}"
echo "Version ARN: ${FUNCTION_VERSION_ARN}"
echo "Use this ARN when attaching to CloudFront as a Lambda@Edge trigger."
