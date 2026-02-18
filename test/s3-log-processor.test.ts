import type { Context, EventBridgeEvent, Handler } from 'aws-lambda';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const s3Mocks = vi.hoisted(() => {
  const send = vi.fn();
  const S3Client = vi.fn().mockImplementation(function S3ClientMock() {
    return {
      send
    };
  });
  const GetObjectCommand = vi.fn().mockImplementation(function GetObjectCommandMock(input: unknown) {
    return {
      input
    };
  });

  return {
    send,
    S3Client,
    GetObjectCommand
  };
});

const sitelineMocks = vi.hoisted(() => {
  const track = vi.fn<(data: unknown) => void>();
  const Siteline = vi.fn().mockImplementation(function SitelineMock() {
    return {
      track
    };
  });

  return {
    track,
    Siteline
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: s3Mocks.S3Client,
    GetObjectCommand: s3Mocks.GetObjectCommand
  };
});

vi.mock('@siteline/core', () => {
  return {
    Siteline: sitelineMocks.Siteline
  };
});

interface S3ObjectCreatedDetail {
  bucket: {
    name: string;
  };
  object: {
    key: string;
  };
}

type S3LogEvent = EventBridgeEvent<string, S3ObjectCreatedDetail>;
type S3LogHandler = Handler<S3LogEvent, void>;

const createEvent = (
  bucketName = 'cf-log-bucket',
  objectKey = 'logs%2F2026-02-18-00.gz'
): S3LogEvent => {
  return {
    version: '0',
    id: 'event-id',
    'detail-type': 'Object Created',
    source: 'aws.s3',
    account: '123456789012',
    time: '2026-02-18T12:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      bucket: {
        name: bucketName
      },
      object: {
        key: objectKey
      }
    }
  };
};

const createContext = (): Context => {
  return {
    awsRequestId: 'aws-request-id',
    callbackWaitsForEmptyEventLoop: false,
    functionName: 's3-log-processor',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:s3-log-processor',
    memoryLimitInMB: '256',
    logGroupName: '/aws/lambda/s3-log-processor',
    logStreamName: '2026/02/18/[$LATEST]1234567890',
    getRemainingTimeInMillis: () => 10_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined
  };
};

const buildLog = (rows: readonly string[]): string => {
  return [
    '#Version: 1.0',
    '#Fields: date time c-ip cs-method cs-host cs-uri-query cs-uri-stem sc-status time-taken cs(User-Agent) cs(Referer)',
    ...rows
  ].join('\n');
};

const setS3Body = (rawLog: string): void => {
  const gzipped = gzipSync(Buffer.from(rawLog, 'utf8'));
  s3Mocks.send.mockResolvedValue({
    Body: {
      transformToByteArray: vi.fn().mockResolvedValue(gzipped)
    }
  });
};

const loadHandler = async (): Promise<S3LogHandler> => {
  const module = await import('../src/handlers/s3-log-processor.js');
  return module.handler as S3LogHandler;
};

const invokeHandler = async (handler: S3LogHandler, event: S3LogEvent): Promise<void> => {
  await handler(event, createContext(), () => undefined);
};

describe('s3-log-processor handler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    process.env.APP_NAME = 'siteline-cloudfront-s3-processor';
    process.env.SITELINE_WEBSITE_KEY = 'siteline_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.SITELINE_ENDPOINT = 'https://siteline.ai/v1/intake/pageview';
    process.env.SITELINE_DEBUG = 'false';

    s3Mocks.send.mockReset();
    s3Mocks.S3Client.mockReset();
    s3Mocks.GetObjectCommand.mockReset();
    s3Mocks.S3Client.mockImplementation(function S3ClientMock() {
      return {
        send: s3Mocks.send
      };
    });
    s3Mocks.GetObjectCommand.mockImplementation(function GetObjectCommandMock(input: unknown) {
      return {
        input
      };
    });

    sitelineMocks.track.mockReset();
    sitelineMocks.Siteline.mockReset();
    sitelineMocks.Siteline.mockImplementation(function SitelineMock() {
      return {
        track: sitelineMocks.track
      };
    });
  });

  it('tracks pageviews from a valid gzip CloudFront log file', async () => {
    setS3Body(
      buildLog([
        '2026-02-18\t12:00:00\t203.0.113.10\tGET\td111111abcdef8.cloudfront.net\ta=1&b=2\t/health\t204\t0.123\tMozilla%2F5.0%20(Test)\thttps%3A%2F%2Fexample.com%2F',
        '2026-02-18\t12:00:01\t203.0.113.11\tPOST\td111111abcdef8.cloudfront.net\t-\t/api/ingest\t201\t0.01\t-\t-',
        '2026-02-18\t12:00:02\t203.0.113.12\tGET\td111111abcdef8.cloudfront.net\tdebug=true\t/not-found\t404\t1.5\tcurl%2F8.7.1\thttps%3A%2F%2Fref.example%2Fpath'
      ])
    );

    const handler = await loadHandler();
    await invokeHandler(handler, createEvent());

    expect(s3Mocks.GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'cf-log-bucket',
      Key: 'logs/2026-02-18-00.gz'
    });

    expect(sitelineMocks.track).toHaveBeenCalledTimes(3);
    expect(sitelineMocks.track).toHaveBeenNthCalledWith(1, {
      url: 'https://d111111abcdef8.cloudfront.net/health?a=1&b=2',
      method: 'GET',
      status: 204,
      duration: 123,
      userAgent: 'Mozilla/5.0 (Test)',
      ref: 'https://example.com/',
      ip: '203.0.113.10'
    });
    expect(sitelineMocks.track).toHaveBeenNthCalledWith(2, {
      url: 'https://d111111abcdef8.cloudfront.net/api/ingest',
      method: 'POST',
      status: 201,
      duration: 10,
      userAgent: null,
      ref: null,
      ip: '203.0.113.11'
    });
    expect(sitelineMocks.track).toHaveBeenNthCalledWith(3, {
      url: 'https://d111111abcdef8.cloudfront.net/not-found?debug=true',
      method: 'GET',
      status: 404,
      duration: 1500,
      userAgent: 'curl/8.7.1',
      ref: 'https://ref.example/path',
      ip: '203.0.113.12'
    });
  });

  it('skips rows with invalid status or missing uri without throwing', async () => {
    setS3Body(
      buildLog([
        '2026-02-18\t12:00:00\t203.0.113.10\tGET\td111111abcdef8.cloudfront.net\ta=1\t/invalid-missing-status\t-\t0.4\tMozilla%2F5.0\t-',
        '2026-02-18\t12:00:01\t203.0.113.11\tGET\td111111abcdef8.cloudfront.net\ta=1\t/invalid-non-numeric-status\tabc\t0.4\tMozilla%2F5.0\t-',
        '2026-02-18\t12:00:02\t203.0.113.12\tGET\td111111abcdef8.cloudfront.net\ta=1\t-\t200\t0.4\tMozilla%2F5.0\t-',
        '2026-02-18\t12:00:03\t203.0.113.13\tGET\td111111abcdef8.cloudfront.net\tok=1\t/valid\t200\t0.4\tMozilla%2F5.0\t-'
      ])
    );

    const handler = await loadHandler();

    await expect(invokeHandler(handler, createEvent())).resolves.toBeUndefined();
    expect(sitelineMocks.track).toHaveBeenCalledTimes(1);
    expect(sitelineMocks.track).toHaveBeenCalledWith({
      url: 'https://d111111abcdef8.cloudfront.net/valid?ok=1',
      method: 'GET',
      status: 200,
      duration: 400,
      userAgent: 'Mozilla/5.0',
      ref: null,
      ip: '203.0.113.13'
    });
  });

  it('is fail-open on malformed rows and continues processing valid rows', async () => {
    setS3Body(
      buildLog([
        '2026-02-18\t12:00:00\t203.0.113.10\tGET\td111111abcdef8.cloudfront.net\ta=1\t/first\t200\t0.2\tMozilla%2F5.0\t-',
        'malformed-row-without-tab-columns',
        '2026-02-18\t12:00:02\t203.0.113.12\tGET\td111111abcdef8.cloudfront.net\t-\t/third\t200\t0.3\tcurl%2F8.7.1\t-'
      ])
    );

    const handler = await loadHandler();

    await expect(invokeHandler(handler, createEvent())).resolves.toBeUndefined();
    expect(sitelineMocks.track).toHaveBeenCalledTimes(2);
    expect(sitelineMocks.track).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'https://d111111abcdef8.cloudfront.net/first?a=1',
        status: 200,
        duration: 200
      })
    );
    expect(sitelineMocks.track).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'https://d111111abcdef8.cloudfront.net/third',
        status: 200,
        duration: 300
      })
    );
  });

  it('skips processing when website key is missing', async () => {
    process.env.SITELINE_WEBSITE_KEY = '';

    const handler = await loadHandler();
    await expect(invokeHandler(handler, createEvent())).resolves.toBeUndefined();

    expect(sitelineMocks.Siteline).not.toHaveBeenCalled();
    expect(sitelineMocks.track).not.toHaveBeenCalled();
    expect(s3Mocks.send).not.toHaveBeenCalled();
  });

  it('throws when S3 download fails', async () => {
    s3Mocks.send.mockRejectedValue(new Error('s3 unavailable'));

    const handler = await loadHandler();

    await expect(invokeHandler(handler, createEvent())).rejects.toThrow('s3 unavailable');
    expect(sitelineMocks.track).not.toHaveBeenCalled();
  });
});
