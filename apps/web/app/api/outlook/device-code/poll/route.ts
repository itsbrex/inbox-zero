import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { serializeSignedCookie } from "better-call";
import {
  pollDeviceCodeFlow,
  isMSALDeviceCodeEnabled,
  getMSALApp,
} from "@/utils/outlook/msal-device-code";
import { createOutlookClient } from "@/utils/outlook/client";
import { encryptToken } from "@/utils/encryption";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { env } from "@/env";
import { WELCOME_PATH } from "@/utils/config";

const logger = createScopedLogger("api:msal:device-code:poll");

interface CompletionResult {
  email: string;
  redirectUrl: string;
  message: string;
  signedSessionToken: string;
  sessionExpires: Date;
}

interface CompletionEntry {
  promise: Promise<CompletionResult>;
  expiresAt: Date;
}

type PollCompleteResult = NonNullable<
  Awaited<ReturnType<typeof pollDeviceCodeFlow>>["result"]
>;

const COMPLETION_CACHE_TTL_MS = 5 * 60 * 1000;
const completionCache = getCompletionCache();

const pollRequestSchema = z.object({
  sessionId: z.string().min(1, "Session ID is required"),
});

export async function POST(request: NextRequest) {
  if (!isMSALDeviceCodeEnabled()) {
    return NextResponse.json(
      { error: "MSAL device code authentication is not enabled" },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();
    const { sessionId } = pollRequestSchema.parse(body);

    logger.info("Poll request received", { sessionId });

    cleanupCompletionCache();
    const cachedCompletion = completionCache.get(sessionId);
    if (cachedCompletion) {
      return respondWithCompletionPromise({
        sessionId,
        entry: cachedCompletion,
      });
    }

    const pollResult = await pollDeviceCodeFlow(sessionId);

    logger.info("Poll result", { sessionId, status: pollResult.status });

    if (pollResult.status === "pending") {
      return NextResponse.json({ status: "pending" });
    }

    if (pollResult.status === "expired") {
      const completedEntry = completionCache.get(sessionId);
      if (completedEntry) {
        return respondWithCompletionPromise({
          sessionId,
          entry: completedEntry,
        });
      }
      logger.info("Flow expired or not found", { sessionId });
      return NextResponse.json({ status: "expired" });
    }

    if (pollResult.status === "error") {
      logger.error("Flow error", { sessionId, error: pollResult.error });
      return NextResponse.json({
        status: "error",
        error: pollResult.error,
      });
    }

    // Authentication complete - create/update account
    if (pollResult.status === "complete" && pollResult.result) {
      const completionPromise = completeDeviceCodeAuthentication({
        pollResult: pollResult.result,
        request,
      });

      completionCache.set(sessionId, {
        promise: completionPromise,
        expiresAt: new Date(Date.now() + COMPLETION_CACHE_TTL_MS),
      });

      return respondWithCompletionPromise({
        sessionId,
        entry: completionCache.get(sessionId)!,
      });
    }

    return NextResponse.json({ status: pollResult.status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { status: "error", error: "Invalid request body" },
        { status: 400 },
      );
    }

    logger.error("Poll failed", { error });
    return NextResponse.json(
      { status: "error", error: "Poll failed" },
      { status: 500 },
    );
  }
}

async function respondWithCompletionPromise({
  sessionId,
  entry,
}: {
  sessionId: string;
  entry: CompletionEntry;
}): Promise<NextResponse> {
  try {
    const completion = await entry.promise;
    return buildCompletionResponse(completion);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Authentication failed";
    logger.error("MSAL device code completion failed", {
      sessionId,
      error: errorMessage,
    });
    return NextResponse.json({ status: "error", error: errorMessage });
  }
}

async function completeDeviceCodeAuthentication({
  pollResult,
  request,
}: {
  pollResult: PollCompleteResult;
  request: NextRequest;
}): Promise<CompletionResult> {
  const { accessToken, expiresAt, scopes, account } = pollResult;

  if (!account) {
    throw new Error("No account info in token response");
  }

  // Get user profile from Microsoft Graph
  const client = createOutlookClient(accessToken, logger);
  const profile = await client.getUserProfile();

  const email =
    profile.mail?.toLowerCase() || profile.userPrincipalName?.toLowerCase();
  const name = profile.displayName;
  const providerAccountId = account.localAccountId;

  if (!email) {
    throw new Error("Could not determine user email");
  }

  // Encrypt tokens
  const encryptedAccessToken = encryptToken(accessToken);

  // Find or create user
  let user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: name || email,
        emailVerified: true,
      },
    });
    logger.info("Created new user via MSAL device code", { email });
  }

  // Create or update account
  // Note: MSAL device code flow doesn't provide refresh_token directly
  // The token cache handles refresh internally, but for our purposes
  // we need to use the existing OAuth refresh mechanism
  const accountRecord = await prisma.account.upsert({
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
      refresh_token: null, // MSAL doesn't expose refresh token
      expires_at: expiresAt,
      token_type: "Bearer",
      scope: scopes.join(" "),
    },
    update: {
      access_token: encryptedAccessToken,
      expires_at: expiresAt,
      scope: scopes.join(" "),
    },
  });

  logger.info("MSAL device code authentication complete", {
    email,
    providerAccountId,
  });

  // Persist the MSAL cache for future token refresh
  // This enables token refresh to survive server restarts
  try {
    const app = getMSALApp();
    const tokenCache = app.getTokenCache();
    const serializedCache = tokenCache.serialize();

    if (serializedCache) {
      const encryptedCache = encryptToken(serializedCache);
      if (encryptedCache) {
        await prisma.account.updateMany({
          where: {
            provider: "microsoft",
            providerAccountId,
          },
          data: {
            msal_cache: encryptedCache,
            msal_cache_updated: new Date(),
          },
        });
        logger.info("Persisted initial MSAL cache", { providerAccountId });
      }
    }
  } catch (cacheError) {
    // Non-fatal - log but don't fail the auth flow
    // Cache will be re-populated on next successful token acquisition
    logger.error("Failed to persist initial MSAL cache", {
      providerAccountId,
      error: cacheError instanceof Error ? cacheError.message : String(cacheError),
    });
  }

  await prisma.$transaction([
    prisma.emailAccount.upsert({
      where: { email },
      update: {
        userId: user.id,
        accountId: accountRecord.id,
        name: name || email,
      },
      create: {
        email,
        userId: user.id,
        accountId: accountRecord.id,
        name: name || email,
      },
    }),
    prisma.account.update({
      where: { id: accountRecord.id },
      data: { disconnectedAt: null },
    }),
  ]);

  // Create a Better Auth session for the user
  const sessionToken = crypto.randomUUID();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: sessionExpires,
      ipAddress: request.headers.get("x-forwarded-for") || "unknown",
      userAgent: request.headers.get("user-agent") || "unknown",
    },
  });

  logger.info("Created session for MSAL device code user", {
    email,
    userId: user.id,
  });

  const signedSessionToken = await signSessionToken(sessionToken);

  return {
    email,
    redirectUrl: WELCOME_PATH,
    message: "Authentication successful! Redirecting...",
    signedSessionToken,
    sessionExpires,
  };
}

function buildCompletionResponse({
  email,
  redirectUrl,
  message,
  signedSessionToken,
  sessionExpires,
}: CompletionResult): NextResponse {
  const isProduction = env.NODE_ENV === "production";
  const cookieName = getSessionCookieName(isProduction);
  const response = NextResponse.json({
    status: "complete",
    email,
    redirectUrl,
    message,
  });

  response.cookies.set(cookieName, signedSessionToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires: sessionExpires,
  });

  logger.info("Set session cookie", {
    cookieName,
    email,
  });

  return response;
}

async function signSessionToken(sessionToken: string): Promise<string> {
  const secret = env.AUTH_SECRET || env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("Missing auth secret for session cookie signing");
  }
  const signed = await serializeSignedCookie("", sessionToken, secret);
  return normalizeSignedCookie(signed);
}

function normalizeSignedCookie(signed: string): string {
  const decodedOnce = decodeURIComponent(signed);
  const decodedTwice = decodedOnce.includes("%")
    ? decodeURIComponent(decodedOnce)
    : decodedOnce;
  return decodedTwice.replace(/^=/, "");
}

function getSessionCookieName(isProduction: boolean): string {
  return isProduction
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
}

function cleanupCompletionCache(): void {
  const now = Date.now();
  for (const [sessionId, entry] of completionCache.entries()) {
    if (entry.expiresAt.getTime() <= now) {
      completionCache.delete(sessionId);
    }
  }
}

function getCompletionCache(): Map<string, CompletionEntry> {
  const globalForCompletion = globalThis as unknown as {
    msalCompletionCache: Map<string, CompletionEntry> | undefined;
  };

  const cache = globalForCompletion.msalCompletionCache ?? new Map();
  if (process.env.NODE_ENV !== "production") {
    globalForCompletion.msalCompletionCache = cache;
  }

  return cache;
}
