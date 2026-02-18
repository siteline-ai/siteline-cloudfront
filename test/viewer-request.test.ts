import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudFrontResponseEvent,
  CloudFrontResponseResult,
  CloudFrontResultResponse,
  Context,
  Handler
} from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sitelineMocks = vi.hoisted(() => {
  const track = vi.fn<(data: unknown) => void>();
  const Siteline = vi.fn().mockImplementation(() => {
    return {
      track
    };
  });

  return {
    track,
    Siteline
  };
});

vi.mock('@siteline/core', () => {
  return {
    Siteline: sitelineMocks.Siteline
  };
});

type EdgeEvent = CloudFrontRequestEvent | CloudFrontResponseEvent;
type EdgeResult = CloudFrontRequestResult | CloudFrontResponseResult;
type EdgeHandler = Handler<EdgeEvent, EdgeResult>;

const createRequest = (): CloudFrontRequest => {
  return {
    clientIp: '203.0.113.10',
    method: 'GET',
    uri: '/health',
    querystring: 'a=1',
    headers: {
      host: [{ key: 'Host', value: 'd111111abcdef8.cloudfront.net' }],
      'user-agent': [{ key: 'User-Agent', value: 'vitest' }],
      referer: [{ key: 'Referer', value: 'https://example.com/' }]
    }
  };
};

const createViewerRequestEvent = (request: CloudFrontRequest = createRequest()): CloudFrontRequestEvent => {
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd111111abcdef8.cloudfront.net',
            distributionId: 'EDFDVBD6EXAMPLE',
            eventType: 'viewer-request',
            requestId: 'request-id'
          },
          request
        }
      }
    ]
  };
};

const createViewerResponseEvent = (
  request: CloudFrontRequest,
  status = '204'
): CloudFrontResponseEvent => {
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd111111abcdef8.cloudfront.net',
            distributionId: 'EDFDVBD6EXAMPLE',
            eventType: 'viewer-response',
            requestId: 'request-id'
          },
          request,
          response: {
            status,
            statusDescription: 'No Content',
            headers: {
              'content-type': [{ key: 'Content-Type', value: 'text/plain' }]
            }
          }
        }
      }
    ]
  };
};

const createContext = (): Context => {
  return {
    awsRequestId: 'aws-request-id',
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
    memoryLimitInMB: '128',
    logGroupName: '/aws/lambda/test-function',
    logStreamName: '2025/01/01/[$LATEST]1234567890',
    getRemainingTimeInMillis: () => 1000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined
  };
};

const isCloudFrontRequestResult = (
  result: EdgeResult | null | undefined
): result is CloudFrontRequest => {
  return typeof result === 'object' && result !== null && 'uri' in result && 'method' in result;
};

const isCloudFrontResultResponse = (
  result: EdgeResult | null | undefined
): result is CloudFrontResultResponse => {
  return typeof result === 'object' && result !== null && 'status' in result;
};

const loadHandler = async (): Promise<EdgeHandler> => {
  const module = await import('../src/handlers/viewer-request.js');
  return module.handler as EdgeHandler;
};

const invokeHandler = async (
  handler: EdgeHandler,
  event: EdgeEvent,
  context: Context
): Promise<EdgeResult> => {
  const result = await handler(event, context, () => undefined);
  if (result === undefined || result === null) {
    throw new Error('Handler returned an empty result.');
  }

  return result;
};

describe('viewer-request / viewer-response handler', () => {
  beforeEach(() => {
    vi.resetModules();

    process.env.APP_NAME = 'siteline-cloudfront-edge';
    process.env.SITELINE_WEBSITE_KEY = 'siteline_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.SITELINE_ENDPOINT = 'https://siteline.ai/v1/intake/pageview';
    process.env.SITELINE_DEBUG = 'false';

    sitelineMocks.Siteline.mockClear();
    sitelineMocks.track.mockClear();
  });

  it('tracks viewer-response with real status and elapsed duration', async () => {
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_350);

    const handler = await loadHandler();

    const requestResult = await invokeHandler(handler, createViewerRequestEvent(), createContext());
    if (!isCloudFrontRequestResult(requestResult)) {
      throw new Error('Expected viewer-request to return CloudFront request.');
    }

    const responseEvent = createViewerResponseEvent(requestResult, '204');
    const responseResult = await invokeHandler(handler, responseEvent, createContext());

    expect(sitelineMocks.track).toHaveBeenCalledTimes(1);
    expect(sitelineMocks.track).toHaveBeenCalledWith({
      url: 'https://d111111abcdef8.cloudfront.net/health?a=1',
      method: 'GET',
      status: 204,
      duration: 350,
      userAgent: 'vitest',
      ref: 'https://example.com/',
      ip: '203.0.113.10'
    });

    if (isCloudFrontResultResponse(responseResult)) {
      expect(responseResult.status).toBe('204');
    } else {
      throw new Error('Expected viewer-response to return CloudFront response.');
    }

    dateNowSpy.mockRestore();
  });

  it('is fail-open when tracking throws and still returns the response unchanged', async () => {
    sitelineMocks.track.mockImplementation(() => {
      throw new Error('tracking failed');
    });

    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_050);

    const handler = await loadHandler();

    const requestResult = await invokeHandler(handler, createViewerRequestEvent(), createContext());
    if (!isCloudFrontRequestResult(requestResult)) {
      throw new Error('Expected viewer-request to return CloudFront request.');
    }

    const responseResult = await invokeHandler(
      handler,
      createViewerResponseEvent(requestResult, '200'),
      createContext()
    );

    if (isCloudFrontResultResponse(responseResult)) {
      expect(responseResult.status).toBe('200');
    } else {
      throw new Error('Expected viewer-response to return CloudFront response.');
    }

    dateNowSpy.mockRestore();
  });

  it('skips tracking when website key is missing and keeps response unchanged', async () => {
    delete process.env.SITELINE_WEBSITE_KEY;

    const handler = await loadHandler();

    const requestResult = await invokeHandler(handler, createViewerRequestEvent(), createContext());
    if (!isCloudFrontRequestResult(requestResult)) {
      throw new Error('Expected viewer-request to return CloudFront request.');
    }

    const responseResult = await invokeHandler(
      handler,
      createViewerResponseEvent(requestResult, '206'),
      createContext()
    );

    expect(sitelineMocks.Siteline).not.toHaveBeenCalled();
    expect(sitelineMocks.track).not.toHaveBeenCalled();

    if (isCloudFrontResultResponse(responseResult)) {
      expect(responseResult.status).toBe('206');
    } else {
      throw new Error('Expected viewer-response to return CloudFront response.');
    }
  });
});
