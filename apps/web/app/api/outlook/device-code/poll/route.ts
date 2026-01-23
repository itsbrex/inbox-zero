import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  pollDeviceCodeFlow,
  isMSALDeviceCodeEnabled,
} from "@/utils/outlook/msal-device-code";
import { createOutlookClient } from "@/utils/outlook/client";
import { encryptToken } from "@/utils/encryption";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";

const logger = createScopedLogger("api:msal:device-code:poll");

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

    const pollResult = await pollDeviceCodeFlow(sessionId);

    if (pollResult.status === "pending") {
      return NextResponse.json({ status: "pending" });
    }

    if (pollResult.status === "expired") {
      return NextResponse.json({ status: "expired" });
    }

    if (pollResult.status === "error") {
      return NextResponse.json({
        status: "error",
        error: pollResult.error,
      });
    }

    // Authentication complete - create/update account
    if (pollResult.status === "complete" && pollResult.result) {
      const { accessToken, expiresAt, scopes, account } = pollResult.result;

      if (!account) {
        return NextResponse.json(
          { status: "error", error: "No account info in token response" },
          { status: 400 },
        );
      }

      // Get user profile from Microsoft Graph
      const client = createOutlookClient(accessToken, logger);
      const profile = await client.getUserProfile();

      const email =
        profile.mail?.toLowerCase() || profile.userPrincipalName?.toLowerCase();
      const name = profile.displayName;
      const providerAccountId = account.localAccountId;

      if (!email) {
        return NextResponse.json(
          { status: "error", error: "Could not determine user email" },
          { status: 400 },
        );
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

      // Note: This endpoint doesn't create a session - the user should
      // then log in via the normal flow which will find their account
      return NextResponse.json({
        status: "complete",
        email,
        message:
          "Account linked successfully. You can now log in with your Microsoft account.",
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
