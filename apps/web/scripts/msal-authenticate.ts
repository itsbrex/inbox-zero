#!/usr/bin/env npx tsx

/**
 * MSAL Device Code Authentication Script
 *
 * Usage: pnpm msal:auth
 *
 * This script initiates a device code authentication flow for Microsoft accounts.
 * It's useful for CLI/headless environments where browser OAuth isn't convenient.
 *
 * Requirements:
 * - Set MSAL_ENABLED=true in your .env
 * - Optionally set MSAL_CLIENT_ID and MSAL_TENANT_ID
 */

/* eslint-disable no-console */

import {
  PublicClientApplication,
  type DeviceCodeRequest,
} from "@azure/msal-node";
import { spawn } from "node:child_process";

// Configuration - these mirror the values in utils/msal/config.ts
const MICROSOFT_OFFICE_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
const CLIENT_ID = process.env.MSAL_CLIENT_ID || MICROSOFT_OFFICE_CLIENT_ID;
const TENANT_ID = process.env.MSAL_TENANT_ID || "common";
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;

// Use .default scope for device code flow with Microsoft Office client ID
// This requests all pre-authorized permissions without requiring explicit consent
const SCOPES = ["https://graph.microsoft.com/.default"];

async function main() {
  console.log("\n============================================================");
  console.log("        INBOX ZERO - MICROSOFT AUTHENTICATION");
  console.log("============================================================\n");
  console.log(`Client ID: ${CLIENT_ID.slice(0, 8)}...`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log("");

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
      console.log(
        "============================================================",
      );
      console.log("                  AUTHENTICATION SUCCESSFUL");
      console.log(
        "============================================================\n",
      );

      console.log(`Email: ${response.account?.username}`);
      console.log(`Name: ${response.account?.name || "N/A"}`);
      console.log(`Account ID: ${response.account?.localAccountId}`);
      console.log(`Scopes: ${response.scopes.join(", ")}`);
      console.log(`Expires: ${response.expiresOn?.toISOString()}`);

      console.log(
        "\n------------------------------------------------------------",
      );
      console.log("Token Information (for manual integration):");
      console.log(
        "------------------------------------------------------------",
      );
      console.log(`Access Token: ${response.accessToken.slice(0, 50)}...`);
      console.log(`Token Length: ${response.accessToken.length} characters`);

      console.log(
        "\n------------------------------------------------------------",
      );
      console.log("Next Steps:");
      console.log(
        "------------------------------------------------------------",
      );
      console.log("1. Ensure MSAL_ENABLED=true is set in your .env");
      console.log("2. Start the web server: pnpm dev");
      console.log("3. Use the API endpoints to authenticate:");
      console.log("   POST /api/outlook/device-code/initiate");
      console.log("   POST /api/outlook/device-code/poll\n");
    }
  } catch (error) {
    console.error(
      "\n============================================================",
    );
    console.error("                  AUTHENTICATION FAILED");
    console.error(
      "============================================================\n",
    );

    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);

      if (error.message.includes("authorization_pending")) {
        console.error("\nThe user did not complete authentication in time.");
      } else if (error.message.includes("authorization_declined")) {
        console.error("\nThe user declined the authentication request.");
      } else if (error.message.includes("expired_token")) {
        console.error("\nThe device code has expired. Please try again.");
      }
    } else {
      console.error(`Error: ${error}`);
    }

    process.exit(1);
  }
}

main();
