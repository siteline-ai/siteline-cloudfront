#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:-}"
EVENT_TYPE="${EVENT_TYPE:-viewer-request}"
INCLUDE_BODY="${INCLUDE_BODY:-false}"
FUNCTION_VERSION_ARN="${FUNCTION_VERSION_ARN:-}"
LAMBDA_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-siteline-cloudfront-viewer-request}"

if [[ -z "${DISTRIBUTION_ID}" ]]; then
  echo "DISTRIBUTION_ID is required." >&2
  exit 1
fi

if [[ "${AWS_REGION}" != "us-east-1" ]]; then
  echo "CloudFront Lambda@Edge associations must use us-east-1 Lambda versions." >&2
  exit 1
fi

if [[ "${INCLUDE_BODY}" != "true" && "${INCLUDE_BODY}" != "false" ]]; then
  echo "INCLUDE_BODY must be true or false." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for scripts/attach-cloudfront.sh" >&2
  exit 1
fi

AWS_CMD=(aws --region "${AWS_REGION}")
if [[ -n "${AWS_PROFILE}" ]]; then
  AWS_CMD+=(--profile "${AWS_PROFILE}")
fi

if [[ -z "${FUNCTION_VERSION_ARN}" ]]; then
  LATEST_VERSION="$("${AWS_CMD[@]}" lambda list-versions-by-function \
    --function-name "${LAMBDA_FUNCTION_NAME}" \
    --query 'Versions[?Version!=`$LATEST`]|[-1].Version' \
    --output text)"

  if [[ -z "${LATEST_VERSION}" || "${LATEST_VERSION}" == "None" ]]; then
    echo "No published Lambda versions found. Run scripts/deploy.sh first." >&2
    exit 1
  fi

  FUNCTION_VERSION_ARN="$("${AWS_CMD[@]}" lambda get-function \
    --function-name "${LAMBDA_FUNCTION_NAME}:${LATEST_VERSION}" \
    --query 'Configuration.FunctionArn' --output text)"
fi

if [[ ! "${FUNCTION_VERSION_ARN}" =~ :[0-9]+$ ]]; then
  echo "FUNCTION_VERSION_ARN must reference a published numeric version, not $LATEST or alias." >&2
  exit 1
fi

TMP_RESPONSE="$(mktemp)"
TMP_CONFIG="$(mktemp)"
trap 'rm -f "${TMP_RESPONSE}" "${TMP_CONFIG}"' EXIT

echo "Fetching CloudFront distribution config..."
"${AWS_CMD[@]}" cloudfront get-distribution-config --id "${DISTRIBUTION_ID}" >"${TMP_RESPONSE}"

ETAG="$(jq -r '.ETag' "${TMP_RESPONSE}")"
jq '.DistributionConfig' "${TMP_RESPONSE}" >"${TMP_CONFIG}"

if [[ "${INCLUDE_BODY}" == "true" ]]; then
  INCLUDE_BODY_JSON=true
else
  INCLUDE_BODY_JSON=false
fi

tmp_updated="$(mktemp)"
trap 'rm -f "${TMP_RESPONSE}" "${TMP_CONFIG}" "${tmp_updated}"' EXIT

jq \
  --arg eventType "${EVENT_TYPE}" \
  --arg lambdaArn "${FUNCTION_VERSION_ARN}" \
  --argjson includeBody "${INCLUDE_BODY_JSON}" \
  '
  def upsert_association($eventType; $lambdaArn; $includeBody):
    (.LambdaFunctionAssociations.Items // []) as $items
    | ($items | map(select(.EventType != $eventType))) as $others
    | ($others + [{
        EventType: $eventType,
        LambdaFunctionARN: $lambdaArn,
        IncludeBody: $includeBody
      }]) as $updated
    | .LambdaFunctionAssociations = {
        Quantity: ($updated | length),
        Items: $updated
      };

  .DefaultCacheBehavior |= upsert_association($eventType; $lambdaArn; $includeBody)
  | if .CacheBehaviors.Quantity > 0 then
      .CacheBehaviors.Items |= map(upsert_association($eventType; $lambdaArn; $includeBody))
    else
      .
    end
  ' "${TMP_CONFIG}" >"${tmp_updated}"

mv "${tmp_updated}" "${TMP_CONFIG}"

echo "Updating CloudFront distribution ${DISTRIBUTION_ID}..."
"${AWS_CMD[@]}" cloudfront update-distribution \
  --id "${DISTRIBUTION_ID}" \
  --if-match "${ETAG}" \
  --distribution-config "file://${TMP_CONFIG}" >/dev/null

echo "Update submitted. CloudFront propagation can take several minutes."
echo "Attached ${FUNCTION_VERSION_ARN} to ${EVENT_TYPE} on default + ordered cache behaviors."
