import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withEmailAccount } from "@/utils/middleware";
import {
  acquireMSALTokenSilent,
  isMSALDeviceCodeEnabled,
} from "@/utils/outlook/msal-device-code";
import {
  checkExistingConnection,
  createCalendarConnection,
} from "@/utils/calendar/oauth-callback-helpers";
import { createMicrosoftCalendarProvider } from "@/utils/calendar/providers/microsoft";

export type DeviceCodeCalendarConnectResponse =
  | { success: true; connectionId: string }
  | { success: false; error: string };

export const POST = withEmailAccount(
  "outlook/calendar/device-code-connect",
  async (request) => {
    const { emailAccountId } = request.auth;
    const logger = request.logger;

    // Step 1: Check if MSAL is enabled
    if (!isMSALDeviceCodeEnabled()) {
      logger.warn("MSAL device code flow is not enabled");
      return NextResponse.json(
        { success: false, error: "Device code flow is not enabled" },
        { status: 400 },
      );
    }

    // Step 2: Get email account with Account relation (including tokens)
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        id: true,
        email: true,
        account: {
          select: {
            provider: true,
            providerAccountId: true,
            refresh_token: true,
            access_token: true,
            expires_at: true,
          },
        },
      },
    });

    if (!emailAccount) {
      logger.warn("Email account not found", { emailAccountId });
      return NextResponse.json(
        { success: false, error: "Email account not found" },
        { status: 404 },
      );
    }

    // Step 3: Verify it's a device-code account
    const isDeviceCodeAuth =
      emailAccount.account?.provider === "microsoft" &&
      !emailAccount.account?.refresh_token;

    if (!isDeviceCodeAuth) {
      logger.warn("Account is not device-code authenticated", {
        emailAccountId,
        provider: emailAccount.account?.provider,
        hasRefreshToken: !!emailAccount.account?.refresh_token,
      });
      return NextResponse.json(
        {
          success: false,
          error: "This endpoint is only for device-code authenticated accounts",
        },
        { status: 400 },
      );
    }

    const providerAccountId = emailAccount.account?.providerAccountId;
    if (!providerAccountId) {
      logger.error("Missing providerAccountId for device-code account", {
        emailAccountId,
      });
      return NextResponse.json(
        { success: false, error: "Account configuration error" },
        { status: 500 },
      );
    }

    // Step 4: Get access token - try stored token first, then MSAL
    let accessToken: string;
    let tokenExpiresAt: Date;

    const storedToken = emailAccount.account?.access_token;
    const storedExpiry = emailAccount.account?.expires_at;
    const tokenStillValid =
      storedToken &&
      storedExpiry &&
      storedExpiry.getTime() > Date.now() + 5 * 60 * 1000; // 5 min buffer

    if (tokenStillValid && storedToken) {
      // Use stored token if still valid
      logger.info("Using stored access token for calendar setup", {
        emailAccountId,
        expiresAt: storedExpiry?.toISOString(),
      });
      // Need to decrypt the token
      const { decryptToken } = await import("@/utils/encryption");
      const decrypted = decryptToken(storedToken);
      if (!decrypted) {
        logger.error("Failed to decrypt stored access token", { emailAccountId });
        return NextResponse.json(
          { success: false, error: "Token decryption failed" },
          { status: 500 },
        );
      }
      accessToken = decrypted;
      tokenExpiresAt = storedExpiry!;
    } else {
      // Try MSAL for token refresh
      const msalResult = await acquireMSALTokenSilent(providerAccountId);

      if (!msalResult) {
        logger.warn("Failed to acquire MSAL token silently", {
          emailAccountId,
          providerAccountId,
        });
        return NextResponse.json(
          {
            success: false,
            error:
              "Authentication expired. Please log in again using device code flow.",
          },
          { status: 401 },
        );
      }

      accessToken = msalResult.accessToken;
      tokenExpiresAt = msalResult.expiresAt;
    }

    // Step 5: Fetch user email from Graph API to verify token works
    let microsoftEmail: string;
    try {
      const profileResponse = await fetch(
        "https://graph.microsoft.com/v1.0/me",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!profileResponse.ok) {
        throw new Error(`Graph API error: ${profileResponse.status}`);
      }

      const profile = await profileResponse.json();
      microsoftEmail = profile.mail || profile.userPrincipalName;

      if (!microsoftEmail) {
        throw new Error("Profile missing email");
      }
    } catch (error) {
      logger.error("Failed to fetch user profile from Graph API", {
        error,
        emailAccountId,
      });
      return NextResponse.json(
        { success: false, error: "Failed to verify Microsoft account" },
        { status: 500 },
      );
    }

    // Step 6: Check for existing connection
    const existingConnection = await checkExistingConnection(
      emailAccountId,
      "microsoft",
      microsoftEmail,
    );

    if (existingConnection) {
      logger.info("Calendar connection already exists", {
        emailAccountId,
        email: microsoftEmail,
      });
      return NextResponse.json({
        success: true,
        connectionId: existingConnection.id,
      });
    }

    // Step 7: Create CalendarConnection with refreshToken = null (device-code flow)
    const connection = await createCalendarConnection({
      provider: "microsoft",
      email: microsoftEmail,
      emailAccountId,
      accessToken,
      refreshToken: "", // Empty string since device-code doesn't provide refresh tokens
      expiresAt: tokenExpiresAt,
    });

    logger.info("Created calendar connection for device-code account", {
      emailAccountId,
      connectionId: connection.id,
      email: microsoftEmail,
    });

    // Step 8: Sync calendars
    try {
      const microsoftProvider = createMicrosoftCalendarProvider(logger);
      await microsoftProvider.syncCalendars(
        connection.id,
        accessToken,
        "", // No refresh token for device-code
        emailAccountId,
        tokenExpiresAt,
        providerAccountId, // Pass for MSAL token refresh
      );

      logger.info("Synced calendars for device-code account", {
        emailAccountId,
        connectionId: connection.id,
      });
    } catch (error) {
      logger.error("Failed to sync calendars", {
        error,
        emailAccountId,
        connectionId: connection.id,
      });
      // Don't fail the entire operation - connection was created
      // Sync can be retried later
    }

    return NextResponse.json({
      success: true,
      connectionId: connection.id,
    });
  },
);
