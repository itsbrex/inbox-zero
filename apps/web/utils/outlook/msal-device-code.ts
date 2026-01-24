/**
 * MSAL Device Code Flow Authentication
 *
 * Provides device-code authentication for Microsoft accounts as an alternative
 * to browser-based OAuth. Useful for CLI/headless environments.
 *
 * Key Features:
 * - Uses MSAL Node.js library for device code flow
 * - In-memory storage for pending flows (15-min expiration)
 * - Integrates with existing token encryption system
 * - Non-breaking: runs parallel to existing Better Auth OAuth
 */

import {
  PublicClientApplication,
  type DeviceCodeRequest,
  type AuthenticationResult,
  type AccountInfo,
  LogLevel,
  type INetworkModule,
  type NetworkRequestOptions,
  type NetworkResponse,
} from "@azure/msal-node";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";

/**
 * Custom network module to handle fetch issues in Node.js 22+
 * Uses fresh fetch calls with abort controller timeouts to avoid
 * undici connection pool issues that cause "fetch failed" errors
 */
class CustomNetworkModule implements INetworkModule {
  private readonly logger = createScopedLogger("msal-network");

  async sendGetRequestAsync<T>(
    url: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    return this.sendRequest<T>(url, "GET", options);
  }

  async sendPostRequestAsync<T>(
    url: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    return this.sendRequest<T>(url, "POST", options);
  }

  private async sendRequest<T>(
    url: string,
    method: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30 second timeout

    try {
      const response = await fetch(url, {
        method,
        headers: options?.headers as Record<string, string>,
        body: options?.body,
        signal: controller.signal,
        // Disable keep-alive to avoid connection pool issues
        keepalive: false,
      });

      clearTimeout(timeoutId);

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const body = (await response.json()) as T;

      return {
        headers,
        body,
        status: response.status,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      this.logger.error("Network request failed", {
        url,
        method,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

// Use .default scope for device code flow with Microsoft Office client ID
// This requests all pre-authorized permissions without requiring explicit consent
const MSAL_DEVICE_CODE_SCOPES = ["https://graph.microsoft.com/.default"];

// DeviceCodeResponse type matches what MSAL passes to the deviceCodeCallback
// Defined locally to avoid importing from @azure/msal-common which is a transitive dep
interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number; // seconds until expiration
  interval: number; // polling interval in seconds
  message: string;
}

const logger = createScopedLogger("msal-device-code");

// Default Microsoft Office client ID - works without app registration
const MICROSOFT_OFFICE_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";

// Singleton MSAL application instance
let msalApp: PublicClientApplication | null = null;

function getMSALApp(): PublicClientApplication {
  if (!msalApp) {
    const clientId =
      env.MSAL_CLIENT_ID ||
      env.MICROSOFT_CLIENT_ID ||
      MICROSOFT_OFFICE_CLIENT_ID;
    const tenantId = env.MSAL_TENANT_ID || env.MICROSOFT_TENANT_ID || "common";
    const debugEnabled = env.MSAL_DEBUG === "true";

    msalApp = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
      system: {
        loggerOptions: {
          loggerCallback: (
            level: LogLevel,
            message: string,
            containsPii: boolean,
          ) => {
            if (containsPii) return; // Don't log PII
            if (debugEnabled || level === LogLevel.Error) {
              logger.info(`MSAL [${LogLevel[level]}]: ${message}`);
            }
          },
          piiLoggingEnabled: false,
          logLevel: debugEnabled ? LogLevel.Verbose : LogLevel.Error,
        },
        // Use custom network module to avoid Node.js 22+ undici connection pool issues
        networkClient: new CustomNetworkModule(),
      },
    });
  }
  return msalApp;
}

// Feature flag - defaults to disabled until explicitly enabled
export function isMSALDeviceCodeEnabled(): boolean {
  return env.MSAL_ENABLED === "true";
}

// Active device code flows (for polling)
interface ActiveFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
  message: string;
  promise: Promise<AuthenticationResult | null>;
  resolve: (result: AuthenticationResult | null) => void;
  reject: (error: Error) => void;
}

// Use globalThis to persist flows across Next.js hot reloads in development
const globalForFlows = globalThis as unknown as {
  msalActiveFlows: Map<string, ActiveFlow> | undefined;
};

const activeFlows =
  globalForFlows.msalActiveFlows ?? new Map<string, ActiveFlow>();

if (process.env.NODE_ENV !== "production") {
  globalForFlows.msalActiveFlows = activeFlows;
}

// Cleanup expired flows periodically
function cleanupExpiredFlows(): void {
  const now = new Date();
  for (const [sessionId, flow] of activeFlows.entries()) {
    if (now > flow.expiresAt) {
      activeFlows.delete(sessionId);
      logger.info("Cleaned up expired device code flow", { sessionId });
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredFlows, 5 * 60 * 1000);

export interface DeviceCodeInitResponse {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
  message: string;
}

/**
 * Initiate device code flow
 * Returns the device code info for display to user
 */
export async function initiateDeviceCodeFlow(
  sessionId: string,
): Promise<DeviceCodeInitResponse> {
  if (!isMSALDeviceCodeEnabled()) {
    throw new Error("MSAL device code flow is not enabled");
  }

  const app = getMSALApp();

  // Clean up expired flows
  cleanupExpiredFlows();

  // Check if session already exists
  if (activeFlows.has(sessionId)) {
    throw new Error("Session already exists");
  }

  let flowResolve: (result: AuthenticationResult | null) => void;
  let flowReject: (error: Error) => void;
  let capturedDeviceCode: DeviceCodeResponse | null = null;

  const flowPromise = new Promise<AuthenticationResult | null>(
    (resolve, reject) => {
      flowResolve = resolve;
      flowReject = reject;
    },
  );

  const deviceCodeRequest: DeviceCodeRequest = {
    scopes: MSAL_DEVICE_CODE_SCOPES,
    deviceCodeCallback: (response: DeviceCodeResponse) => {
      capturedDeviceCode = response;

      // Calculate expiration time from expiresIn (seconds)
      const expiresAt = new Date(Date.now() + response.expiresIn * 1000);

      // Store flow info for polling
      activeFlows.set(sessionId, {
        deviceCode: response.deviceCode,
        userCode: response.userCode,
        verificationUri: response.verificationUri,
        expiresAt,
        message: response.message,
        promise: flowPromise,
        resolve: flowResolve!,
        reject: flowReject!,
      });

      logger.info("Device code flow initiated", {
        sessionId,
        userCode: response.userCode,
        expiresAt: expiresAt.toISOString(),
      });
    },
    timeout: 900, // 15 minutes
  };

  // Start the flow (don't await - it blocks until user completes)
  const authPromise = app.acquireTokenByDeviceCode(deviceCodeRequest);

  // Wait for the callback to be called (provides device code)
  await new Promise<void>((resolve, reject) => {
    const checkInterval = setInterval(() => {
      if (capturedDeviceCode) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);

    // Timeout after 10 seconds if callback not called
    setTimeout(() => {
      clearInterval(checkInterval);
      if (!capturedDeviceCode) {
        reject(new Error("Device code callback timeout"));
      }
    }, 10_000);
  });

  const flow = activeFlows.get(sessionId);
  // Cast is needed because TypeScript doesn't track assignment in async callbacks
  const deviceCodeInfo = capturedDeviceCode as DeviceCodeResponse | null;
  if (!flow || !deviceCodeInfo) {
    throw new Error("Failed to initiate device code flow");
  }

  // Wire up the auth promise to resolve/reject the flow
  authPromise
    .then((result: AuthenticationResult | null) => {
      logger.info("Device code flow completed", { sessionId });
      flow.resolve(result);
    })
    .catch((error: Error) => {
      // Log detailed error info for debugging network issues
      const errorDetails = {
        sessionId,
        error: error.message,
        name: error.name,
        stack: error.stack?.split("\n").slice(0, 5).join("\n"),
        cause: error.cause ? String(error.cause) : undefined,
      };
      logger.error("Device code flow failed", errorDetails);
      flow.reject(error);
    });

  // Calculate expiration time from expiresIn (seconds)
  const expiresAt = new Date(Date.now() + deviceCodeInfo.expiresIn * 1000);

  return {
    sessionId,
    userCode: deviceCodeInfo.userCode,
    verificationUri: deviceCodeInfo.verificationUri,
    expiresAt,
    message: deviceCodeInfo.message,
  };
}

export interface PollResult {
  status: "pending" | "complete" | "expired" | "error";
  error?: string;
  result?: {
    accessToken: string;
    expiresAt: Date;
    scopes: string[];
    account: AccountInfo | null;
  };
}

/**
 * Poll for device code completion
 */
export async function pollDeviceCodeFlow(
  sessionId: string,
): Promise<PollResult> {
  logger.info("Poll called", {
    sessionId,
    activeFlowCount: activeFlows.size,
    hasFlow: activeFlows.has(sessionId),
  });

  const flow = activeFlows.get(sessionId);

  if (!flow) {
    logger.info("Flow not found in activeFlows", { sessionId });
    return { status: "expired" };
  }

  if (new Date() > flow.expiresAt) {
    logger.info("Flow expired", { sessionId, expiresAt: flow.expiresAt });
    activeFlows.delete(sessionId);
    return { status: "expired" };
  }

  // Check if promise is resolved (non-blocking check)
  const raceResult = await Promise.race([
    flow.promise
      .then((result) => ({ done: true as const, result, error: null }))
      .catch((error) => ({ done: true as const, result: null, error })),
    new Promise<{ done: false }>((resolve) =>
      setTimeout(() => resolve({ done: false }), 100),
    ),
  ]);

  if (!raceResult.done) {
    return { status: "pending" };
  }

  // Flow completed - clean up
  activeFlows.delete(sessionId);

  if (raceResult.error) {
    const errorMessage =
      raceResult.error instanceof Error
        ? raceResult.error.message
        : String(raceResult.error);

    // Check for user cancellation
    if (errorMessage.includes("authorization_pending")) {
      return { status: "pending" };
    }

    logger.error("Device code flow error", { sessionId, error: errorMessage });
    return { status: "error", error: errorMessage };
  }

  if (!raceResult.result) {
    return { status: "error", error: "No authentication result" };
  }

  return {
    status: "complete",
    result: {
      accessToken: raceResult.result.accessToken,
      expiresAt:
        raceResult.result.expiresOn || new Date(Date.now() + 3_600_000),
      scopes: raceResult.result.scopes,
      account: raceResult.result.account,
    },
  };
}

/**
 * Cancel an active device code flow
 */
export function cancelDeviceCodeFlow(sessionId: string): boolean {
  const flow = activeFlows.get(sessionId);
  if (flow) {
    flow.reject(new Error("Flow cancelled by user"));
    activeFlows.delete(sessionId);
    logger.info("Device code flow cancelled", { sessionId });
    return true;
  }
  return false;
}

/**
 * Get count of active flows (for monitoring)
 */
export function getActiveFlowCount(): number {
  cleanupExpiredFlows();
  return activeFlows.size;
}

/**
 * Acquire token silently from MSAL cache
 * Used for device-code authenticated accounts to get fresh tokens for calendar operations
 *
 * @param providerAccountId - The MSAL account's localAccountId (stored as providerAccountId in DB)
 * @param scopes - Optional scopes to request (defaults to .default which includes all permissions)
 * @returns Token info or null if account not in cache
 */
export async function acquireMSALTokenSilent(
  providerAccountId: string,
  scopes: string[] = MSAL_DEVICE_CODE_SCOPES,
): Promise<{
  accessToken: string;
  expiresAt: Date;
  account: AccountInfo;
} | null> {
  if (!isMSALDeviceCodeEnabled()) {
    logger.warn("MSAL device code flow is not enabled");
    return null;
  }

  const app = getMSALApp();
  const tokenCache = app.getTokenCache();

  try {
    // Get all accounts from MSAL cache
    const accounts = await tokenCache.getAllAccounts();

    if (accounts.length === 0) {
      logger.info("No accounts found in MSAL cache");
      return null;
    }

    // Find the account matching the providerAccountId
    const account = accounts.find(
      (acc: AccountInfo) => acc.localAccountId === providerAccountId,
    );

    if (!account) {
      logger.info("Account not found in MSAL cache", {
        providerAccountId,
        cachedAccountIds: accounts.map((a: AccountInfo) => a.localAccountId),
      });
      return null;
    }

    // Acquire token silently using cached credentials
    const result = await app.acquireTokenSilent({
      account,
      scopes,
    });

    if (!result) {
      logger.warn("acquireTokenSilent returned null", { providerAccountId });
      return null;
    }

    logger.info("Successfully acquired token silently", {
      providerAccountId,
      expiresOn: result.expiresOn?.toISOString(),
    });

    return {
      accessToken: result.accessToken,
      expiresAt: result.expiresOn || new Date(Date.now() + 3_600_000), // Default 1 hour
      account,
    };
  } catch (error) {
    logger.error("Failed to acquire token silently", {
      providerAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
