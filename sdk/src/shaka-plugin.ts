import {
  MEDIA_SEGMENT_EXTENSION_PATTERN,
  type SegmentDeadline,
} from "@openstreamgrid/common";
import { OpenStreamGridHlsPlugin } from "./hls-plugin.js";
import type { HlsjsPluginConfig } from "./types.js";

/** Shaka request as seen by a scheme plugin (subset used by the adapter). */
export interface ShakaRequest {
  headers?: Record<string, string>;
  /** Shaka sends cookies/credentials cross-site when true. */
  allowCrossSiteCredentials?: boolean;
  /** Shaka aborts a request after `timeout` or after `stallTimeout` without progress (0 disables). */
  retryParameters?: { timeout?: number; stallTimeout?: number };
}

/** Leaves time for the origin response before Shaka's own timeout fires. */
const SHAKA_DEADLINE_MARGIN_MS = 500;

/** Shaka response returned by a scheme plugin. */
export interface ShakaResponse {
  uri: string;
  originalUri: string;
  data: ArrayBuffer | ArrayBufferView;
  headers: Record<string, string>;
  originalRequest: ShakaRequest;
  status?: number;
  timeMs?: number;
  fromCache?: boolean;
}

/** Shaka `IAbortableOperation`. */
export interface ShakaAbortableOperation<T> {
  promise: Promise<T>;
  abort(): unknown;
}

/** Shaka `SchemePlugin` signature. */
export type ShakaSchemePlugin = (
  uri: string,
  request: ShakaRequest,
  requestType: number,
  progressUpdated: (...args: unknown[]) => void,
  headersReceived: (...args: unknown[]) => void,
  config: unknown,
) => ShakaAbortableOperation<ShakaResponse>;

/**
 * The parts of the `shaka` namespace the adapter needs. Pass the namespace
 * your application imported (`import shaka from "shaka-player"`).
 */
export interface ShakaNamespace {
  net: {
    NetworkingEngine: {
      registerScheme(
        scheme: string,
        plugin: ShakaSchemePlugin,
        priority?: number,
        progressSupport?: boolean,
      ): void;
      RequestType: { SEGMENT: number };
      PluginPriority: { APPLICATION: number; PREFERRED: number };
    };
    HttpFetchPlugin: { parse: ShakaSchemePlugin };
  };
  util: {
    AbortableOperation: new <T>(
      promise: Promise<T>,
      onAbort: () => Promise<void>,
    ) => ShakaAbortableOperation<T>;
    /** Shaka's error type; NetworkingEngine retries based on its severity and code. */
    Error: (new (severity: number, category: number, code: number, ...data: unknown[]) => Error) & {
      Severity: { RECOVERABLE: number };
      Category: { NETWORK: number };
      Code: { HTTP_ERROR: number; OPERATION_ABORTED: number };
    };
  };
}

/** Browser SDK options for Shaka Player (the Hls.js options apply unchanged). */
export type ShakaPluginConfig = HlsjsPluginConfig;

const SCHEMES = ["http", "https"] as const;

/**
 * Hybrid P2P-CDN delivery for Shaka Player. Media segment requests (`.ts` and
 * `.m4s`, without a Range header) go through the grid with the same caching,
 * verification, scheduling, and origin fallback as the Hls.js plugin; every
 * other request uses Shaka's HTTP fetch plugin.
 *
 * Shaka scheme plugins are global, so attach one instance per page.
 */
export class OpenStreamGridShakaPlugin {
  /** Shared delivery core; exposes stats and the tracker client. */
  readonly core: OpenStreamGridHlsPlugin;
  private shaka: ShakaNamespace | undefined;

  constructor(config: ShakaPluginConfig) {
    this.core = new OpenStreamGridHlsPlugin(config);
  }

  /** Routes Shaka's HTTP(S) segment requests through the grid. */
  attach(shaka: ShakaNamespace): void {
    if (this.shaka === shaka) return;
    if (this.shaka) throw new Error("Plugin is already attached to Shaka Player");
    this.core.startGrid();
    this.shaka = shaka;
    const plugin = this.schemePlugin(shaka);
    for (const scheme of SCHEMES) {
      shaka.net.NetworkingEngine.registerScheme(
        scheme,
        plugin,
        shaka.net.NetworkingEngine.PluginPriority.APPLICATION,
      );
    }
  }

  /** Restores Shaka's HTTP fetch plugin and stops the grid. */
  detach(): void {
    const shaka = this.shaka;
    if (!shaka) return;
    this.shaka = undefined;
    for (const scheme of SCHEMES) {
      // Matches Shaka's own registration of its fetch plugin.
      shaka.net.NetworkingEngine.registerScheme(
        scheme,
        shaka.net.HttpFetchPlugin.parse,
        shaka.net.NetworkingEngine.PluginPriority.PREFERRED,
        true,
      );
    }
    this.core.stopGrid();
  }

  private schemePlugin(shaka: ShakaNamespace): ShakaSchemePlugin {
    const fallback = shaka.net.HttpFetchPlugin.parse;
    return (uri, request, requestType, progressUpdated, headersReceived, config) => {
      // The grid fetches plain, uncredentialed GETs. Requests that carry headers
      // (Range, Authorization, tokens added by request filters) or cookies stay
      // on Shaka's fetch plugin so they keep working.
      const customized =
        Object.keys(request.headers ?? {}).length > 0 || request.allowCrossSiteCredentials === true;
      if (
        this.shaka !== shaka ||
        requestType !== shaka.net.NetworkingEngine.RequestType.SEGMENT ||
        customized ||
        !isMediaSegmentUri(uri)
      ) {
        return fallback(uri, request, requestType, progressUpdated, headersReceived, config);
      }
      const controller = new AbortController();
      const startedAt = performance.now();
      const deadline = this.core.isDeadlineSchedulingEnabled()
        ? requestDeadline(request)
        : undefined;
      const promise = this.core
        .loadSegment(segmentName(uri), uri, controller.signal, deadline)
        .then(
          ({ data, fromCache }) => ({
            uri,
            originalUri: uri,
            data,
            headers: {},
            originalRequest: request,
            status: 200,
            timeMs: performance.now() - startedAt,
            // Instant cache hits must not feed Shaka's bandwidth estimator.
            ...(fromCache ? { fromCache: true } : {}),
          }),
          (error: unknown) => {
            throw toShakaError(shaka, uri, requestType, error, controller.signal.aborted);
          },
        );
      return new shaka.util.AbortableOperation(promise, async () => {
        controller.abort(new DOMException("Shaka aborted the request", "AbortError"));
      });
    };
  }
}

/**
 * Shaka gives no playback position to the scheme plugin, but it aborts a
 * request after its retry timeout or stall timeout (5 s by default, and this
 * adapter reports no progress). A synthetic deadline below that budget lets
 * the scheduler hedge to the origin before Shaka gives up on a slow peer.
 */
const requestDeadline = (request: ShakaRequest): SegmentDeadline | undefined => {
  const budgets = [request.retryParameters?.timeout, request.retryParameters?.stallTimeout].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (budgets.length === 0) return undefined;
  return {
    kind: "synthetic",
    slackMs: Math.max(0, Math.min(...budgets) - SHAKA_DEADLINE_MARGIN_MS),
  };
};

const isMediaSegmentUri = (uri: string): boolean => {
  try {
    return MEDIA_SEGMENT_EXTENSION_PATTERN.test(new URL(uri, globalThis.location?.href).pathname);
  } catch {
    return false;
  }
};

/** Same derivation as the Hls.js loader, so both adapters agree on segment names. */
const segmentName = (uri: string): string => uri.slice(uri.lastIndexOf("/") + 1) || uri;

/** Converts grid failures into the error type Shaka's retry logic understands. */
const toShakaError = (
  shaka: ShakaNamespace,
  uri: string,
  requestType: number,
  error: unknown,
  aborted: boolean,
): Error => {
  const ShakaError = shaka.util.Error;
  return aborted
    ? new ShakaError(
        ShakaError.Severity.RECOVERABLE,
        ShakaError.Category.NETWORK,
        ShakaError.Code.OPERATION_ABORTED,
        uri,
        requestType,
      )
    : new ShakaError(
        ShakaError.Severity.RECOVERABLE,
        ShakaError.Category.NETWORK,
        ShakaError.Code.HTTP_ERROR,
        uri,
        error,
        requestType,
      );
};
