import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import {
  initiateDeviceCodeFlow,
  isMSALDeviceCodeEnabled,
} from "@/utils/outlook/msal-device-code";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("api:msal:device-code:initiate");

export async function POST() {
  if (!isMSALDeviceCodeEnabled()) {
    return NextResponse.json(
      { error: "MSAL device code authentication is not enabled" },
      { status: 403 },
    );
  }

  try {
    const sessionId = nanoid();
    const result = await initiateDeviceCodeFlow(sessionId);

    return NextResponse.json({
      sessionId: result.sessionId,
      userCode: result.userCode,
      verificationUri: result.verificationUri,
      expiresAt: result.expiresAt.toISOString(),
      message: result.message,
    });
  } catch (error) {
    logger.error("Device code initiation failed", { error });

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to initiate device code flow: ${errorMessage}` },
      { status: 500 },
    );
  }
}
