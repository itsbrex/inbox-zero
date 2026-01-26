# Code Review: MSAL Device Code Authentication

**Branch:** `feature/alternative-auth-method`
**Target:** `origin/main`
**Date:** 2026-01-25

## Summary

This branch adds **MSAL Device Code Flow authentication** for Microsoft/Outlook accounts as an alternative to browser-based OAuth. This enables CLI/headless authentication and supports environments where browser redirects aren't possible.

**Key changes:**
- New MSAL device code flow implementation (`msal-device-code.ts`, `msal-cache-plugin.ts`)
- API endpoints for initiating and polling device code auth
- Frontend component for the device code login flow
- Database schema changes to store MSAL token cache
- Integration with existing Outlook client for token refresh
- Comprehensive test suite

---

## Issues Found

| Severity | File:Line | Issue | Suggestion |
|----------|-----------|-------|------------|
| High | `msal-device-code.ts:249` | `setInterval` for cleanup runs indefinitely at module level, which can cause memory leaks and issues with hot reloading | Use `unref()` on the interval or implement a proper cleanup mechanism that can be torn down |
| High | `poll/route.ts:281` | Session token is generated with `crypto.randomUUID()` which may not match Better Auth's expected token format | Verify this integrates correctly with Better Auth's session validation, or use Better Auth's session creation API |
| Medium | `msal-device-code.ts:147` | Non-null assertion `msalAppCache.get(cacheKey)!` after `has()` check could fail in race conditions | Use the result of `get()` directly with a null check |
| Medium | `poll/route.ts:230` | `getMSALApp()` is called without `providerAccountId`, using the default instance instead of the per-account cached instance | Should use `getMSALApp(providerAccountId)` to ensure proper cache plugin is attached for persistence |
| Medium | `msal-device-code.ts:307-308` | Using `flowResolve!` and `flowReject!` with non-null assertions before they're guaranteed to be assigned | Move the assertion inside the Promise executor or restructure |
| Medium | `DeviceCodeLogin.tsx:141-145` | Polling interval (3s) continues even when component is unmounted if `flowState` is "polling" | The cleanup in `useEffect` stops polling via `shouldPollRef`, but the `pollOnce` recursive call may still be pending |
| Low | `msal-device-code.ts:170-171` | Logger callback logs errors at `logger.info` level even for `LogLevel.Error` | Use `logger.error` for error-level MSAL messages |
| Low | `poll/route.ts:375-382` | Completion cache is attached to `globalThis` but only in non-production, causing different behavior between environments | Consider using consistent behavior or documenting this intentional difference |
| Low | `msal-device-code.test.ts:45-50` | Mock constructor pattern is complex and may be fragile | Consider using `vi.spyOn` with prototype methods instead |

---

## Additional Observations

### Positive

- Good test coverage for the core device code flow logic
- Proper encryption of tokens before storage
- Graceful fallback from MSAL silent acquisition to direct token refresh
- Feature flag (`MSAL_ENABLED`) for safe rollout
- Custom network module to handle Node.js 22+ fetch issues

### Architecture Concern

The in-memory `activeFlows` map won't work correctly in serverless/multi-instance deployments. If the poll request hits a different instance than the initiate request, the flow won't be found. Consider using Redis or similar for production deployments.

---

## Files Reviewed

### New Files
- `apps/web/utils/outlook/msal-device-code.ts`
- `apps/web/utils/outlook/msal-cache-plugin.ts`
- `apps/web/utils/outlook/msal-device-code.test.ts`
- `apps/web/app/api/outlook/device-code/initiate/route.ts`
- `apps/web/app/api/outlook/device-code/poll/route.ts`
- `apps/web/app/(landing)/login/DeviceCodeLogin.tsx`
- `apps/web/app/(landing)/login/device-code/page.tsx`

### Modified Files
- `apps/web/utils/outlook/client.ts` - Added MSAL token refresh integration
- `apps/web/utils/account.ts` - Added providerAccountId to token retrieval
- `apps/web/env.ts` - Added MSAL configuration variables
- `apps/web/prisma/schema.prisma` - Added msal_cache fields to Account model
