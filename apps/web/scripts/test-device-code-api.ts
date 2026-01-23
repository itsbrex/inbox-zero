#!/usr/bin/env npx tsx

/**
 * API Test Script for MSAL Device Code Endpoints
 *
 * Tests the device code authentication flow endpoints:
 * - POST /api/outlook/device-code/initiate
 * - POST /api/outlook/device-code/poll
 *
 * Usage: npx tsx scripts/test-device-code-api.ts
 *
 * Prerequisites:
 * - MSAL_ENABLED=true in .env
 * - Next.js dev server running on localhost:3000
 */

/* eslint-disable no-console */

import { nanoid } from "nanoid";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

interface InitiateResponse {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  message: string;
  error?: string;
}

interface PollResponse {
  status: "pending" | "complete" | "expired" | "error";
  email?: string;
  error?: string;
  message?: string;
}

async function testInitiateEndpoint(): Promise<InitiateResponse | null> {
  console.log("\n=== Testing POST /api/outlook/device-code/initiate ===\n");

  try {
    const response = await fetch(
      `${BASE_URL}/api/outlook/device-code/initiate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    console.log(`Status: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as InitiateResponse;
    console.log("Response:", JSON.stringify(data, null, 2));

    if (response.ok) {
      console.log("\n✅ Initiate endpoint working!");
      console.log(`   User Code: ${data.userCode}`);
      console.log(`   Verification URL: ${data.verificationUri}`);
      console.log(`   Session ID: ${data.sessionId}`);
      return data;
    } else {
      console.log("\n❌ Initiate endpoint returned error:");
      console.log(`   ${data.error || "Unknown error"}`);
      return null;
    }
  } catch (error) {
    console.error("\n❌ Failed to reach initiate endpoint:");
    console.error(
      `   ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    console.error(
      "\n   Make sure the Next.js dev server is running on port 3000",
    );
    return null;
  }
}

async function testPollEndpoint(sessionId: string): Promise<void> {
  console.log("\n=== Testing POST /api/outlook/device-code/poll ===\n");

  try {
    const response = await fetch(`${BASE_URL}/api/outlook/device-code/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    console.log(`Status: ${response.status} ${response.statusText}`);

    const data = (await response.json()) as PollResponse;
    console.log("Response:", JSON.stringify(data, null, 2));

    if (response.ok) {
      console.log(`\n✅ Poll endpoint working! Status: ${data.status}`);

      if (data.status === "pending") {
        console.log("   (User hasn't completed authentication yet)");
      } else if (data.status === "complete") {
        console.log(`   Email: ${data.email}`);
        console.log(`   Message: ${data.message}`);
      } else if (data.status === "expired") {
        console.log(
          "   (Session expired - this is expected for test sessions)",
        );
      } else if (data.status === "error") {
        console.log(`   Error: ${data.error}`);
      }
    } else {
      console.log("\n❌ Poll endpoint returned error");
    }
  } catch (error) {
    console.error("\n❌ Failed to reach poll endpoint:");
    console.error(
      `   ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

async function testPollWithInvalidSession(): Promise<void> {
  console.log("\n=== Testing poll with invalid session ID ===\n");

  const invalidSessionId = nanoid();

  try {
    const response = await fetch(`${BASE_URL}/api/outlook/device-code/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: invalidSessionId }),
    });

    const data = (await response.json()) as PollResponse;
    console.log(`Status: ${response.status}, Response status: ${data.status}`);

    if (data.status === "expired") {
      console.log("✅ Correctly returned 'expired' for invalid session");
    } else {
      console.log(`❌ Expected 'expired', got '${data.status}'`);
    }
  } catch (error) {
    console.error("❌ Request failed:", error);
  }
}

async function testPollWithMissingSessionId(): Promise<void> {
  console.log("\n=== Testing poll with missing session ID ===\n");

  try {
    const response = await fetch(`${BASE_URL}/api/outlook/device-code/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const data = (await response.json()) as PollResponse;
    console.log(
      `Status: ${response.status}, Response: ${JSON.stringify(data)}`,
    );

    if (response.status === 400) {
      console.log("✅ Correctly returned 400 for missing session ID");
    } else {
      console.log(`❌ Expected 400, got ${response.status}`);
    }
  } catch (error) {
    console.error("❌ Request failed:", error);
  }
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log("    MSAL Device Code API Endpoint Tests");
  console.log("============================================================");
  console.log(`\nBase URL: ${BASE_URL}`);

  // Test initiate endpoint
  const initiateResult = await testInitiateEndpoint();

  if (initiateResult?.sessionId) {
    // Small delay to ensure flow is registered
    console.log("\nWaiting 500ms before polling...");
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Test poll endpoint with valid session
    await testPollEndpoint(initiateResult.sessionId);
  }

  // Test poll with invalid session
  await testPollWithInvalidSession();

  // Test poll with missing session ID
  await testPollWithMissingSessionId();

  console.log("\n============================================================");
  console.log("    Tests Complete");
  console.log("============================================================\n");
}

main().catch(console.error);
