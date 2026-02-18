import { Siteline, type PageviewData, type SitelineConfig } from '@siteline/core';
import type {
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudFrontResponseEvent,
  CloudFrontResponseResult,
  CloudFrontResultResponse,
  Handler
} from 'aws-lambda';

import { appConfig } from '../config/env';
import {DEFAULT_INTEGRATION_TYPE, DEFAULT_SDK_NAME, DEFAULT_SDK_VERSION} from "../config/constants";

type EdgeEvent = CloudFrontRequestEvent | CloudFrontResponseEvent;
type EdgeResult = CloudFrontRequestResult | CloudFrontResponseResult;
type TrackableRequest = Pick<CloudFrontRequest, 'clientIp' | 'method' | 'uri' | 'querystring' | 'headers'>;

const TRACK_START_HEADER = 'x-siteline-track-start-ms';
const TRACK_START_HEADER_KEY = 'X-Siteline-Track-Start-Ms';

const INVALID_EVENT_RESPONSE: CloudFrontResultResponse = {
  status: '400',
  statusDescription: 'Bad Request',
  headers: {
    'content-type': [
      {
        key: 'Content-Type',
        value: 'application/json'
      }
    ],
    'cache-control': [
      {
        key: 'Cache-Control',
        value: 'no-store'
      }
    ]
  },
  body: JSON.stringify({
    error: 'Invalid CloudFront event payload'
  })
};

const getHeaderValue = (headers: CloudFrontHeaders, headerName: string): string | null => {
  return headers[headerName.toLowerCase()]?.[0]?.value ?? null;
};

const setHeaderValue = (headers: CloudFrontHeaders, headerName: string, value: string): void => {
  headers[headerName.toLowerCase()] = [
    {
      key: TRACK_START_HEADER_KEY,
      value
    }
  ];
};

const parseStatus = (status: string): number => {
  const parsed = Number.parseInt(status, 10);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : 0;
};

const parseTrackStartTimestamp = (request: TrackableRequest): number | undefined => {
  const rawValue = getHeaderValue(request.headers, TRACK_START_HEADER);
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const computeDurationMs = (request: TrackableRequest): number => {
  const startedAtMs = parseTrackStartTimestamp(request);
  if (startedAtMs === undefined) {
    return 0;
  }

  return Math.max(0, Date.now() - startedAtMs);
};

const toPageviewData = (request: TrackableRequest, status: string): PageviewData => {
  const host = getHeaderValue(request.headers, 'host');
  const query = request.querystring ? `?${request.querystring}` : '';

  return {
    url: host ? `https://${host}${request.uri}${query}` : `${request.uri}${query}`,
    method: request.method,
    status: parseStatus(status),
    duration: computeDurationMs(request),
    userAgent: getHeaderValue(request.headers, 'user-agent'),
    ref: getHeaderValue(request.headers, 'referer'),
    ip: request.clientIp || null
  };
};

const siteline = (() => {
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
      integrationType: DEFAULT_INTEGRATION_TYPE,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown Siteline initialization error';
    console.error(
      JSON.stringify({
        service: appConfig.appName,
        message: 'Siteline initialization failed; tracking disabled.',
        errorMessage: message
      })
    );
    return undefined;
  }
})();

const trackViewerResponse = (request: TrackableRequest, status: string): void => {
  if (!siteline) {
    return;
  }

  try {
    siteline.track(toPageviewData(request, status));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown tracking error';
    console.error(
      JSON.stringify({
        service: appConfig.appName,
        message: 'Siteline track call failed; response continues unchanged.',
        errorMessage: message
      })
    );
  }
};

const handleViewerRequest = (event: CloudFrontRequestEvent): CloudFrontRequestResult => {
  const request = event.Records[0]?.cf.request;
  if (!request) {
    return INVALID_EVENT_RESPONSE;
  }

  // CloudFront does not provide a first-byte/request-start timestamp in Lambda@Edge events.
  // We stamp viewer-request time and compute elapsed time when viewer-response runs.
  setHeaderValue(request.headers, TRACK_START_HEADER, String(Date.now()));

  return request;
};

const handleViewerResponse = (event: CloudFrontResponseEvent): CloudFrontResponseResult => {
  const record = event.Records[0];
  if (!record) {
    return INVALID_EVENT_RESPONSE;
  }

  trackViewerResponse(record.cf.request, record.cf.response.status);
  return record.cf.response;
};

export const handler: Handler<EdgeEvent, EdgeResult> = (event) => {
  const record = event.Records[0];
  if (!record) {
    return Promise.resolve(INVALID_EVENT_RESPONSE);
  }

  if (record.cf.config.eventType === 'viewer-response') {
    return Promise.resolve(handleViewerResponse(event as CloudFrontResponseEvent));
  }

  if (record.cf.config.eventType === 'viewer-request') {
    return Promise.resolve(handleViewerRequest(event as CloudFrontRequestEvent));
  }
};
