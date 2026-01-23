# Planning Prompt: MSAL Device-Code Flow Implementation

## Objective
Create a minimal-change, reversible implementation plan for adding MSAL device-code flow authentication to inbox-zero, based on the research findings from the ResearchPack.

## Prerequisites
- Completed ResearchPack from `/Users/hack/github/inbox-zero/.claude/prompts/msal-integration-research.md`
- Understanding of inbox-zero's Better Auth architecture
- Knowledge of microsoft-mcp's MSAL implementation patterns

## Implementation Architecture

### Recommended Approach: Parallel Auth Method

The MSAL device-code flow should exist **alongside** Better Auth's Microsoft OAuth, not replace it:

```
Authentication Methods:
├── Better Auth (existing)
│   ├── Google OAuth (unchanged)
│   └── Microsoft OAuth (unchanged, browser-based)
│
└── MSAL Device Code (new)
    ├── CLI/Headless authentication
    ├── Uses same Account/EmailAccount tables
    ├── Tokens encrypted with existing encryption.ts
    └── Creates/links to Better Auth sessions
```

### Why Parallel vs Replacement?
1. **User choice** - Web users prefer browser OAuth, CLI/API users may need device code
2. **No breaking changes** - Existing users continue with current flow
3. **Simpler testing** - Can test MSAL independently
4. **Rollback** - Can disable MSAL without affecting core auth

## File Change Summary

### New Files to Create

```
apps/web/
├── utils/
│   └── msal/
│       ├── index.ts            # Main exports
│       ├── auth.ts             # MSALAuth class (port of auth_msal.py)
│       ├── config.ts           # MSAL configuration
│       ├── scopes.ts           # Graph API scopes for inbox-zero features
│       └── types.ts            # TypeScript interfaces
├── app/
│   └── api/
│       └── msal/
│           ├── device-code/
│           │   └── route.ts    # Initiate device code flow
│           ├── poll/
│           │   └── route.ts    # Poll for authentication completion
│           └── callback/
│               └── route.ts    # Handle token receipt, create session
└── scripts/
    └── msal-authenticate.ts    # CLI authentication script
```

### Existing Files to Modify

```
apps/web/
├── utils/
│   ├── outlook/
│   │   └── client.ts           # Add MSAL token source option
│   └── env.ts                  # Add MSAL env vars (if not dynamic)
├── prisma/
│   └── schema.prisma           # Possibly add authMethod field to Account
└── package.json                # Add @azure/msal-node dependency
```

## Detailed Implementation Plan

### Phase 1: Core MSAL Infrastructure

**Goal:** Port MSALRefreshTokenAuth functionality to TypeScript

#### Step 1.1: Add Dependencies
```bash
# In apps/web
pnpm add @azure/msal-node
```

#### Step 1.2: Create MSAL Types (`apps/web/utils/msal/types.ts`)
```typescript
export interface MSALConfig {
  clientId: string;
  tenantId: string;
  scopes: string[];
}

export interface DeviceCodeResponse {
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
  message: string;
}

export interface MSALTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string;
}
```

#### Step 1.3: Create MSAL Config (`apps/web/utils/msal/config.ts`)
```typescript
// Default Microsoft Office client ID (works without app registration)
export const DEFAULT_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";

export const MSAL_CONFIG = {
  clientId: process.env.MSAL_CLIENT_ID || DEFAULT_CLIENT_ID,
  tenantId: process.env.MSAL_TENANT_ID || "common",
  authority: `https://login.microsoftonline.com/${process.env.MSAL_TENANT_ID || "common"}`,
};
```

#### Step 1.4: Create MSAL Auth Class (`apps/web/utils/msal/auth.ts`)
Port key methods from Python:
- `initiateDeviceCodeFlow()` - Start device code flow
- `acquireTokenByDeviceCode()` - Complete flow with polling
- `refreshAccessToken()` - Refresh expired tokens
- `getToken()` - Get valid token (auto-refresh)

### Phase 2: API Routes

**Goal:** Create HTTP endpoints for device code flow

#### Step 2.1: Device Code Initiation (`apps/web/app/api/msal/device-code/route.ts`)
```typescript
// POST /api/msal/device-code
// Returns: { userCode, verificationUri, expiresAt, message }
```

#### Step 2.2: Polling Endpoint (`apps/web/app/api/msal/poll/route.ts`)
```typescript
// POST /api/msal/poll
// Body: { deviceCode }
// Returns: { status: "pending" | "complete" | "expired", tokens?: MSALTokens }
```

#### Step 2.3: Token Callback (`apps/web/app/api/msal/callback/route.ts`)
```typescript
// POST /api/msal/callback
// Handles token receipt:
// 1. Encrypt tokens
// 2. Create/update Account record
// 3. Create/update EmailAccount record
// 4. Create Better Auth session
// Returns: { success, redirectUrl }
```

### Phase 3: Account Integration

**Goal:** Integrate MSAL tokens with existing account system

#### Step 3.1: Account Creation
When MSAL auth completes:
1. Fetch user profile via Graph API (`/me`)
2. Create User record if new
3. Create Account record with:
   - `provider: "microsoft"`
   - `providerAccountId: oid from token claims`
   - `access_token`: Encrypted access token
   - `refresh_token`: Encrypted refresh token
   - Add `authMethod: "msal"` field (optional, for tracking)
4. Create EmailAccount record
5. Create Better Auth session

#### Step 3.2: Token Refresh Integration
Modify `apps/web/utils/outlook/client.ts`:
```typescript
// Add MSAL refresh as fallback/alternative
async function getValidToken(account: Account): Promise<string> {
  // Check if token expired
  if (isTokenExpired(account)) {
    // Try Better Auth refresh first (existing)
    // If fails and authMethod === "msal", use MSAL refresh
  }
  return decrypt(account.access_token);
}
```

### Phase 4: CLI Script

**Goal:** Create standalone CLI tool for device code auth

#### Step 4.1: Create Script (`apps/web/scripts/msal-authenticate.ts`)
```typescript
#!/usr/bin/env npx tsx

// Usage: npx tsx scripts/msal-authenticate.ts
// Or: pnpm msal:auth

// Steps:
// 1. Initialize MSAL PublicClientApplication
// 2. Start device code flow
// 3. Display user code and verification URL
// 4. Open browser (macOS/Linux)
// 5. Poll for completion
// 6. Call /api/msal/callback to create session
// 7. Output success/session token
```

#### Step 4.2: Add Package.json Script
```json
{
  "scripts": {
    "msal:auth": "tsx scripts/msal-authenticate.ts"
  }
}
```

### Phase 5: Environment Configuration

**Goal:** Add required environment variables

#### New Variables:
```bash
# Optional - defaults provided
MSAL_CLIENT_ID=d3590ed6-52b3-4102-aeff-aad2292ab01c
MSAL_TENANT_ID=common
MSAL_ENABLED=true  # Feature flag
```

## Rollback Procedure

If issues arise, rollback is straightforward:

1. **Disable feature flag:** Set `MSAL_ENABLED=false`
2. **Remove routes:** Delete `apps/web/app/api/msal/` directory
3. **Remove utils:** Delete `apps/web/utils/msal/` directory
4. **Revert package.json:** Remove `@azure/msal-node` dependency
5. **No schema changes needed:** Account records remain compatible

## Testing Plan

### Unit Tests
```
apps/web/utils/msal/__tests__/
├── auth.test.ts        # MSAL auth class tests
├── config.test.ts      # Configuration validation
└── integration.test.ts # Token flow simulation
```

### Integration Tests
1. Mock MSAL responses
2. Test device code flow end-to-end
3. Test token refresh
4. Test account creation

### Manual Testing Checklist
- [ ] Initiate device code flow
- [ ] Complete authentication via browser
- [ ] Verify tokens stored encrypted
- [ ] Verify Account/EmailAccount created
- [ ] Verify session created
- [ ] Test token refresh after expiry
- [ ] Test email operations with MSAL token
- [ ] Verify existing OAuth flows unaffected

## Security Checklist

- [ ] Tokens encrypted with existing AES-256-GCM
- [ ] No tokens logged or exposed in responses
- [ ] Device code has reasonable expiration
- [ ] Rate limiting on poll endpoint
- [ ] CSRF protection on API routes
- [ ] Session created with appropriate TTL

## Success Criteria

Implementation is complete when:
- [ ] Device code flow works end-to-end
- [ ] Tokens stored encrypted in database
- [ ] Session created compatible with Better Auth
- [ ] Email operations work with MSAL tokens
- [ ] CLI script authenticates successfully
- [ ] All existing functionality preserved
- [ ] Tests passing
- [ ] Documentation updated

## File Creation Order

1. `apps/web/utils/msal/types.ts`
2. `apps/web/utils/msal/config.ts`
3. `apps/web/utils/msal/scopes.ts`
4. `apps/web/utils/msal/auth.ts`
5. `apps/web/utils/msal/index.ts`
6. `apps/web/app/api/msal/device-code/route.ts`
7. `apps/web/app/api/msal/poll/route.ts`
8. `apps/web/app/api/msal/callback/route.ts`
9. `apps/web/scripts/msal-authenticate.ts`
10. Modify `apps/web/utils/outlook/client.ts`
11. Add tests
12. Update documentation
