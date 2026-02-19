import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Siteline, type PageviewData, type SitelineConfig } from '@siteline/core';
import type { EventBridgeEvent, Handler } from 'aws-lambda';
import { gunzipSync } from 'node:zlib';

import {
  DEFAULT_INTEGRATION_TYPE,
  DEFAULT_SDK_NAME,
  DEFAULT_SDK_VERSION
} from '../config/constants';
import { appConfig } from '../config/env';

interface S3ObjectCreatedDetail {
  bucket?: {
    name?: string;
  };
  object?: {
    key?: string;
  };
}

interface CloudFrontLogFieldMap {
  index: Readonly<Record<string, number>>;
  columnCount: number;
}

type S3LogEvent = EventBridgeEvent<string, S3ObjectCreatedDetail>;

const COMMENT_PREFIX = '#';
const FIELDS_PREFIX = '#Fields:';

const s3Client = new S3Client({ region: process.env.AWS_REGION || process.env.S3_BUCKET_REGION });

const logTrackingError = (message: string, error: unknown): void => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error(
    JSON.stringify({
      service: appConfig.appName,
      message,
      errorMessage
    })
  );
};

const createSitelineClient = (): Siteline | undefined => {
  const websiteKey = appConfig.siteline.websiteKey;
  if (!websiteKey) {
    return undefined;
  }

  const config: SitelineConfig = {
    websiteKey,
    debug: appConfig.siteline.debug
  };

  if (appConfig.siteline.endpoint) {
    config.endpoint = appConfig.siteline.endpoint;
  }

  try {
    return new Siteline({
      ...config,
      sdk: DEFAULT_SDK_NAME,
      sdkVersion: DEFAULT_SDK_VERSION,
      integrationType: DEFAULT_INTEGRATION_TYPE
    });
  } catch (error: unknown) {
    logTrackingError('Siteline initialization failed; tracking disabled.', error);
    return undefined;
  }
};

const siteline = createSitelineClient();

const decodeS3ObjectKey = (value: string): string => {
  return decodeURIComponent(value.replace(/\+/g, ' '));
};

const decodeLogValue = (value: string | undefined): string | null => {
  if (!value || value === '-') {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const parseFieldMap = (rawLog: string): CloudFrontLogFieldMap => {
  const fieldsLine = rawLog
    .split(/\r?\n/)
    .find((line) => line.startsWith(FIELDS_PREFIX));

  if (!fieldsLine) {
    throw new Error('CloudFront log is missing the #Fields header line.');
  }

  const fieldNames = fieldsLine
    .slice(FIELDS_PREFIX.length)
    .trim()
    .split(/\s+/)
    .filter((field) => field.length > 0);

  if (fieldNames.length === 0) {
    throw new Error('CloudFront log has an empty #Fields header line.');
  }

  return {
    index: Object.fromEntries(fieldNames.map((field, idx) => [field, idx])),
    columnCount: fieldNames.length
  };
};

const parseStatus = (value: string | undefined): number | undefined => {
  if (!value || value === '-') {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    return undefined;
  }

  return parsed;
};

const parseDurationMs = (value: string | undefined): number => {
  if (!value || value === '-') {
    return 0;
  }

  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 0;
  }

  return Math.round(seconds * 1000);
};

const getField = (columns: readonly string[], fieldMap: CloudFrontLogFieldMap, fieldName: string): string | undefined => {
  const index = fieldMap.index[fieldName];
  return index === undefined ? undefined : columns[index];
};

const toPageviewData = (line: string, fieldMap: CloudFrontLogFieldMap): PageviewData | undefined => {
  const columns = line.split('\t');
  if (columns.length < fieldMap.columnCount) {
    throw new Error('CloudFront log row column count does not match the #Fields header.');
  }

  const status = parseStatus(getField(columns, fieldMap, 'sc-status'));
  if (status === undefined) {
    return undefined;
  }

  const uri = getField(columns, fieldMap, 'cs-uri-stem');
  if (!uri || uri === '-') {
    return undefined;
  }

  const host = decodeLogValue(getField(columns, fieldMap, 'cs(Host)') ?? getField(columns, fieldMap, 'x-host-header'));
  const query = getField(columns, fieldMap, 'cs-uri-query');
  const querySuffix = query && query !== '-' ? `?${query}` : '';
  const url = host ? `https://${host}${uri}${querySuffix}` : `${uri}${querySuffix}`;

  const method = getField(columns, fieldMap, 'cs-method');

  return {
    url,
    method: method && method !== '-' ? method : 'UNKNOWN',
    status,
    duration: parseDurationMs(getField(columns, fieldMap, 'time-taken')),
    userAgent: decodeLogValue(getField(columns, fieldMap, 'cs(User-Agent)')),
    ref: decodeLogValue(getField(columns, fieldMap, 'cs(Referer)')),
    ip: decodeLogValue(getField(columns, fieldMap, 'c-ip'))
  };
};

const getObjectBodyBuffer = async (bucketName: string, objectKey: string): Promise<Buffer> => {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey
    })
  );

  const body = response.Body;
  if (!body || typeof body !== 'object' || !('transformToByteArray' in body)) {
    throw new Error('S3 GetObject returned an empty or unsupported body.');
  }

  const transform = body.transformToByteArray;
  if (typeof transform !== 'function') {
    throw new Error('S3 GetObject body does not support transformToByteArray().');
  }

  const payload = await transform.call(body);
  return Buffer.from(payload);
};

const getRawLogFile = async (bucketName: string, objectKey: string): Promise<string> => {
  let gzippedContent: Buffer;
  try {
    gzippedContent = await getObjectBodyBuffer(bucketName, objectKey);
  } catch (error: unknown) {
    logTrackingError('Failed to download CloudFront log object from S3.', error);
    throw error;
  }

  try {
    return gunzipSync(gzippedContent).toString('utf8');
  } catch (error: unknown) {
    logTrackingError('Failed to decompress CloudFront log object.', error);
    throw error;
  }
};

const getBucketAndKey = (event: S3LogEvent): { bucketName: string; objectKey: string } => {
  const bucketName = event.detail?.bucket?.name;
  const rawObjectKey = event.detail?.object?.key;

  if (!bucketName || !rawObjectKey) {
    const error = new Error('EventBridge S3 event is missing bucket.name or object.key.');
    logTrackingError('Invalid S3 event payload.', error);
    throw error;
  }

  let objectKey: string;
  try {
    objectKey = decodeS3ObjectKey(rawObjectKey);
  } catch (error: unknown) {
    logTrackingError('Failed to decode S3 object key from event payload.', error);
    throw error;
  }

  return {
    bucketName,
    objectKey
  };
};

export const handler: Handler<S3LogEvent, void> = async (event) => {
  if (!siteline) {
    return;
  }

  const { bucketName, objectKey } = getBucketAndKey(event);
  const rawLog = await getRawLogFile(bucketName, objectKey);
  const fieldMap = parseFieldMap(rawLog);

  const trackPromises: Promise<void>[] = [];

  for (const line of rawLog.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith(COMMENT_PREFIX)) {
      continue;
    }

    try {
      const pageview = toPageviewData(trimmedLine, fieldMap);
      if (!pageview) {
        continue;
      }

      trackPromises.push(siteline.track(pageview));
    } catch (error: unknown) {
      logTrackingError('Failed to parse CloudFront log row; row skipped.', error);
    }
  }

  await Promise.all(trackPromises);
};
