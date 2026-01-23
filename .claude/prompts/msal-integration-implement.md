# Implementation Prompt: MSAL Device-Code Flow

## Objective
Implement MSAL device-code flow authentication in inbox-zero following the approved implementation plan. Execute changes using TDD (Red-Green-Refactor) with self-correction up to 3 retries.

## Prerequisites
- Approved Implementation Plan: `/Users/hack/github/inbox-zero/.claude/prompts/msal-integration-plan.md`
- ResearchPack: `/Users/hack/github/inbox-zero/.claude/prompts/msal-integration-research.md`
- Source Reference: `/Users/hack/github/microsoft-mcp/src/microsoft_mcp/auth_msal.py`

## Implementation Constraints

### CRITICAL: Preserve Existing Functionality
- **DO NOT** modify Better Auth configuration in `apps/web/utils/auth.ts`
- **DO NOT** change existing Microsoft OAuth flow
- **DO NOT** alter existing Account/EmailAccount table structure (unless adding optional fields)
- **DO NOT** break existing session management

### Code Style
- Follow existing inbox-zero patterns (see `apps/web/utils/outlook/*.ts`)
- Use TypeScript strict mode
- Use Zod for schema validation
- Use existing encryption utilities from `apps/web/utils/encryption.ts`
- Follow existing error handling patterns

### Testing Requirements
- Write tests BEFORE implementation (TDD)
- Mock external MSAL calls
- Test error scenarios
- Ensure 80%+ coverage for new code

## Step-by-Step Implementation

### Step 1: Add MSAL Dependency

```bash
cd apps/web
pnpm add @azure/msal-node
```

Verify in `package.json`:
```json
{
  "dependencies": {
    "@azure/msal-node": "^2.x.x"
  }
}
```

### Step 2: Create Type Definitions

**File:** `apps/web/utils/msal/types.ts`

```typescript
import { z } from "zod";

// Device code flow response from MSAL
export const DeviceCodeResponseSchema = z.object({
  userCode: z.string(),
  verificationUri: z.string().url(),
  expiresOn: z.date(),
  message: z.string(),
  deviceCode: z.string(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

// Token response after successful auth
export const MSALTokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresOn: z.date(),
  scopes: z.array(z.string()),
  account: z.object({
    homeAccountId: z.string(),
    environment: z.string(),
    tenantId: z.string(),
    username: z.string(),
    localAccountId: z.string(),
    name: z.string().optional(),
  }).nullable(),
});
export type MSALTokenResponse = z.infer<typeof MSALTokenResponseSchema>;

// Configuration
export interface MSALConfig {
  clientId: string;
  tenantId: string;
  authority: string;
}

// API response types
export interface DeviceCodeAPIResponse {
  userCode: string;
  verificationUri: string;
  expiresAt: string; // ISO date string
  message: string;
  sessionId: string; // For tracking the flow
}

export interface PollAPIResponse {
  status: "pending" | "complete" | "expired" | "error";
  error?: string;
  redirectUrl?: string;
}
```

### Step 3: Create MSAL Configuration

**File:** `apps/web/utils/msal/config.ts`

```typescript
import { Configuration, LogLevel } from "@azure/msal-node";

// Default Microsoft Office client ID - works without app registration
// This is the same ID used by Microsoft Office apps
export const MICROSOFT_OFFICE_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";

// Get configuration from environment or use defaults
export function getMSALConfig(): Configuration {
  const clientId = process.env.MSAL_CLIENT_ID || MICROSOFT_OFFICE_CLIENT_ID;
  const tenantId = process.env.MSAL_TENANT_ID || "common";

  return {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    system: {
      loggerOptions: {
        loggerCallback: (level, message, containsPii) => {
          if (!containsPii) {
            const logFn = level === LogLevel.Error
              ? console.error
              : level === LogLevel.Warning
                ? console.warn
                : console.log;
            if (process.env.MSAL_DEBUG === "true") {
              logFn(`MSAL: ${message}`);
            }
          }
        },
        piiLoggingEnabled: false,
        logLevel: process.env.MSAL_DEBUG === "true" ? LogLevel.Verbose : LogLevel.Error,
      },
    },
  };
}

// Feature flag
export function isMSALEnabled(): boolean {
  return process.env.MSAL_ENABLED !== "false";
}
```

### Step 4: Create MSAL Scopes

**File:** `apps/web/utils/msal/scopes.ts`

```typescript
// Microsoft Graph scopes needed for inbox-zero email features
// These match the scopes defined in apps/web/utils/outlook/scopes.ts

export const MSAL_SCOPES = [
  // Core email access
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",

  // Calendar access (if using calendar features)
  "https://graph.microsoft.com/Calendars.Read",
  "https://graph.microsoft.com/Calendars.ReadWrite",

  // User profile
  "https://graph.microsoft.com/User.Read",

  // Contacts
  "https://graph.microsoft.com/Contacts.Read",

  // Required for refresh tokens
  "offline_access",
];

// Minimal scopes for basic email functionality
export const MSAL_SCOPES_MINIMAL = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];
```

### Step 5: Create MSAL Auth Service

**File:** `apps/web/utils/msal/auth.ts`

```typescript
import {
  PublicClientApplication,
  DeviceCodeRequest,
  AuthenticationResult,
  AccountInfo,
} from "@azure/msal-node";
import { getMSALConfig } from "./config";
import { MSAL_SCOPES } from "./scopes";
import type { DeviceCodeResponse, MSALTokenResponse } from "./types";

// Singleton MSAL application instance
let msalApp: PublicClientApplication | null = null;

function getMSALApp(): PublicClientApplication {
  if (!msalApp) {
    msalApp = new PublicClientApplication(getMSALConfig());
  }
  return msalApp;
}

// Active device code flows (for polling)
const activeFlows = new Map<string, {
  deviceCodeRequest: DeviceCodeRequest;
  promise: Promise<AuthenticationResult | null>;
  resolve: (result: AuthenticationResult | null) => void;
  reject: (error: Error) => void;
  expiresAt: Date;
}>();

/**
 * Initiate device code flow
 * Returns the device code info for display to user
 */
export async function initiateDeviceCodeFlow(
  sessionId: string,
  scopes: string[] = MSAL_SCOPES
): Promise<DeviceCodeResponse> {
  const app = getMSALApp();

  // Clean up expired flows
  cleanupExpiredFlows();

  let flowResolve: (result: AuthenticationResult | null) => void;
  let flowReject: (error: Error) => void;

  const flowPromise = new Promise<AuthenticationResult | null>((resolve, reject) => {
    flowResolve = resolve;
    flowReject = reject;
  });

  const deviceCodeRequest: DeviceCodeRequest = {
    scopes,
    deviceCodeCallback: (response) => {
      // Store flow info for polling
      activeFlows.set(sessionId, {
        deviceCodeRequest,
        promise: flowPromise,
        resolve: flowResolve!,
        reject: flowReject!,
        expiresAt: response.expiresOn,
      });
    },
    timeout: 900, // 15 minutes
  };

  // Start the flow but don't await completion
  const authPromise = app.acquireTokenByDeviceCode(deviceCodeRequest);

  // Wait for the callback to be called (provides device code)
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      if (activeFlows.has(sessionId)) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);

    // Timeout after 5 seconds if callback not called
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, 5000);
  });

  const flow = activeFlows.get(sessionId);
  if (!flow) {
    throw new Error("Failed to initiate device code flow");
  }

  // Update the promise with the actual auth promise
  authPromise
    .then((result) => flow.resolve(result))
    .catch((error) => flow.reject(error));

  // Extract device code info from the request
  // Note: MSAL doesn't expose this directly, we capture it in callback
  // This is a workaround - in practice you'd capture from the callback

  return {
    userCode: "Check console for code", // MSAL logs the code
    verificationUri: "https://microsoft.com/devicelogin",
    expiresOn: flow.expiresAt,
    message: `To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code shown in the console.`,
    deviceCode: sessionId, // We use sessionId as reference
  };
}

/**
 * Poll for device code completion
 */
export async function pollDeviceCodeFlow(
  sessionId: string
): Promise<{ status: "pending" | "complete" | "expired"; result?: MSALTokenResponse }> {
  const flow = activeFlows.get(sessionId);

  if (!flow) {
    return { status: "expired" };
  }

  if (new Date() > flow.expiresAt) {
    activeFlows.delete(sessionId);
    return { status: "expired" };
  }

  // Check if promise is resolved
  const raceResult = await Promise.race([
    flow.promise.then((result) => ({ done: true, result })),
    new Promise<{ done: false }>((resolve) =>
      setTimeout(() => resolve({ done: false }), 100)
    ),
  ]);

  if (raceResult.done && raceResult.result) {
    activeFlows.delete(sessionId);
    return {
      status: "complete",
      result: {
        accessToken: raceResult.result.accessToken,
        refreshToken: null, // MSAL doesn't expose refresh token directly
        expiresOn: raceResult.result.expiresOn || new Date(Date.now() + 3600000),
        scopes: raceResult.result.scopes,
        account: raceResult.result.account,
      },
    };
  }

  return { status: "pending" };
}

/**
 * Refresh an access token using a cached account
 */
export async function refreshToken(
  accountInfo: AccountInfo
): Promise<AuthenticationResult | null> {
  const app = getMSALApp();

  try {
    const result = await app.acquireTokenSilent({
      scopes: MSAL_SCOPES,
      account: accountInfo,
    });
    return result;
  } catch (error) {
    console.error("MSAL token refresh failed:", error);
    return null;
  }
}

/**
 * Get cached accounts
 */
export async function getCachedAccounts(): Promise<AccountInfo[]> {
  const app = getMSALApp();
  const cache = app.getTokenCache();
  const accounts = await cache.getAllAccounts();
  return accounts;
}

/**
 * Clear MSAL token cache
 */
export async function clearCache(): Promise<void> {
  const app = getMSALApp();
  const cache = app.getTokenCache();
  const accounts = await cache.getAllAccounts();

  for (const account of accounts) {
    await cache.removeAccount(account);
  }
}

/**
 * Cleanup expired flows
 */
function cleanupExpiredFlows(): void {
  const now = new Date();
  for (const [sessionId, flow] of activeFlows.entries()) {
    if (now > flow.expiresAt) {
      activeFlows.delete(sessionId);
    }
  }
}
```

### Step 6: Create Main Export

**File:** `apps/web/utils/msal/index.ts`

```typescript
export * from "./types";
export * from "./config";
export * from "./scopes";
export * from "./auth";
```

### Step 7: Create Device Code API Route

**File:** `apps/web/app/api/msal/device-code/route.ts`

```typescript
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { isMSALEnabled, initiateDeviceCodeFlow } from "@/utils/msal";

export async function POST() {
  if (!isMSALEnabled()) {
    return NextResponse.json(
      { error: "MSAL authentication is not enabled" },
      { status: 403 }
    );
  }

  try {
    const sessionId = nanoid();
    const deviceCode = await initiateDeviceCodeFlow(sessionId);

    return NextResponse.json({
      userCode: deviceCode.userCode,
      verificationUri: deviceCode.verificationUri,
      expiresAt: deviceCode.expiresOn.toISOString(),
      message: deviceCode.message,
      sessionId,
    });
  } catch (error) {
    console.error("Device code initiation failed:", error);
    return NextResponse.json(
      { error: "Failed to initiate device code flow" },
      { status: 500 }
    );
  }
}
```

### Step 8: Create Poll API Route

**File:** `apps/web/app/api/msal/poll/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isMSALEnabled, pollDeviceCodeFlow } from "@/utils/msal";
import { encrypt } from "@/utils/encryption";
import { prisma } from "@/utils/prisma";
import { auth } from "@/utils/auth";

const PollRequestSchema = z.object({
  sessionId: z.string(),
});

export async function POST(request: NextRequest) {
  if (!isMSALEnabled()) {
    return NextResponse.json(
      { error: "MSAL authentication is not enabled" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { sessionId } = PollRequestSchema.parse(body);

    const result = await pollDeviceCodeFlow(sessionId);

    if (result.status === "complete" && result.result) {
      // Authentication complete - create/update account
      const tokenResult = result.result;

      if (!tokenResult.account) {
        return NextResponse.json(
          { status: "error", error: "No account info in token response" },
          { status: 400 }
        );
      }

      const email = tokenResult.account.username;
      const providerAccountId = tokenResult.account.localAccountId;

      // Encrypt tokens
      const encryptedAccessToken = encrypt(tokenResult.accessToken);
      const encryptedRefreshToken = tokenResult.refreshToken
        ? encrypt(tokenResult.refreshToken)
        : null;

      // Find or create user
      let user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email,
            name: tokenResult.account.name || email,
            emailVerified: true,
          },
        });
      }

      // Create or update account
      await prisma.account.upsert({
        where: {
          provider_providerAccountId: {
            provider: "microsoft",
            providerAccountId,
          },
        },
        create: {
          userId: user.id,
          provider: "microsoft",
          providerAccountId,
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshToken,
          expires_at: tokenResult.expiresOn,
          token_type: "Bearer",
          scope: tokenResult.scopes.join(" "),
        },
        update: {
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshToken,
          expires_at: tokenResult.expiresOn,
          scope: tokenResult.scopes.join(" "),
        },
      });

      // Create session using Better Auth's session system
      // This is simplified - actual implementation would use Better Auth's session creation
      const session = await auth.api.createSession({
        userId: user.id,
      });

      return NextResponse.json({
        status: "complete",
        redirectUrl: "/welcome",
      });
    }

    return NextResponse.json({ status: result.status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { status: "error", error: "Invalid request body" },
        { status: 400 }
      );
    }
    console.error("Poll failed:", error);
    return NextResponse.json(
      { status: "error", error: "Poll failed" },
      { status: 500 }
    );
  }
}
```

### Step 9: Create CLI Authentication Script

**File:** `apps/web/scripts/msal-authenticate.ts`

```typescript
#!/usr/bin/env npx tsx

/**
 * MSAL Device Code Authentication Script
 *
 * Usage: pnpm msal:auth
 *
 * This script initiates a device code authentication flow for Microsoft accounts.
 * It's useful for CLI/headless environments where browser OAuth isn't convenient.
 */

import { PublicClientApplication, DeviceCodeRequest } from "@azure/msal-node";
import { spawn } from "child_process";
import * as readline from "readline";

// Configuration
const CLIENT_ID = process.env.MSAL_CLIENT_ID || "d3590ed6-52b3-4102-aeff-aad2292ab01c";
const TENANT_ID = process.env.MSAL_TENANT_ID || "common";
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;

const SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];

async function main() {
  console.log("\n============================================================");
  console.log("        INBOX ZERO - MICROSOFT AUTHENTICATION");
  console.log("============================================================\n");

  const msalConfig = {
    auth: {
      clientId: CLIENT_ID,
      authority: AUTHORITY,
    },
  };

  const pca = new PublicClientApplication(msalConfig);

  const deviceCodeRequest: DeviceCodeRequest = {
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.log("To sign in, use a web browser to open the page:");
      console.log(`\n  ${response.verificationUri}\n`);
      console.log(`Enter the code: ${response.userCode}\n`);

      // Try to copy to clipboard (macOS)
      if (process.platform === "darwin") {
        try {
          const pbcopy = spawn("pbcopy");
          pbcopy.stdin.write(response.userCode);
          pbcopy.stdin.end();
          console.log("(Code copied to clipboard)");
        } catch {
          // Ignore clipboard errors
        }

        // Try to open browser
        try {
          spawn("open", [response.verificationUri]);
          console.log("(Opening browser...)");
        } catch {
          // Ignore browser errors
        }
      }

      console.log("\nWaiting for authentication...\n");
    },
  };

  try {
    const response = await pca.acquireTokenByDeviceCode(deviceCodeRequest);

    if (response) {
      console.log("============================================================");
      console.log("                  AUTHENTICATION SUCCESSFUL");
      console.log("============================================================\n");

      console.log(`Email: ${response.account?.username}`);
      console.log(`Name: ${response.account?.name || "N/A"}`);
      console.log(`Scopes: ${response.scopes.join(", ")}`);
      console.log(`Expires: ${response.expiresOn?.toISOString()}`);

      // In a real implementation, you'd save these tokens
      // For now, just display success
      console.log("\nTo integrate with inbox-zero:");
      console.log("1. Start the web server: pnpm dev");
      console.log("2. Visit: http://localhost:3000/login");
      console.log("3. Use the MSAL login option\n");
    }
  } catch (error: any) {
    console.error("\n============================================================");
    console.error("                  AUTHENTICATION FAILED");
    console.error("============================================================\n");
    console.error(`Error: ${error.message || error}`);
    process.exit(1);
  }
}

main();
```

### Step 10: Update package.json

Add the following script to `apps/web/package.json`:

```json
{
  "scripts": {
    "msal:auth": "tsx scripts/msal-authenticate.ts"
  }
}
```

## Verification Checklist

After implementation, verify:

- [ ] `pnpm add @azure/msal-node` succeeds
- [ ] TypeScript compiles without errors: `pnpm tsc --noEmit`
- [ ] ESLint passes: `pnpm lint`
- [ ] Unit tests pass: `pnpm test`
- [ ] Dev server starts: `pnpm dev`
- [ ] Device code flow initiates: `POST /api/msal/device-code`
- [ ] Poll returns pending/complete status: `POST /api/msal/poll`
- [ ] CLI script runs: `pnpm msal:auth`
- [ ] Existing Google OAuth still works
- [ ] Existing Microsoft OAuth still works
- [ ] No regressions in email functionality

## Error Handling

If implementation fails:

1. **TypeScript errors:** Check type imports and Zod schemas
2. **MSAL errors:** Check MSAL documentation, verify config
3. **Database errors:** Verify Prisma schema matches expected fields
4. **Session errors:** Better Auth session creation may need adjustment
5. **Encryption errors:** Verify EMAIL_ENCRYPT_SECRET and EMAIL_ENCRYPT_SALT

## Self-Correction Protocol

On error:
1. Read full error message and stack trace
2. Identify root cause (type error, missing import, config issue)
3. Apply minimal fix
4. Re-run verification
5. If 3 retries exhausted, document blocker and pause

## Git Commit Strategy

Commit after each phase:
1. "feat(msal): add MSAL types and configuration"
2. "feat(msal): implement device code auth service"
3. "feat(msal): add API routes for device code flow"
4. "feat(msal): add CLI authentication script"
5. "test(msal): add unit tests for MSAL auth"
