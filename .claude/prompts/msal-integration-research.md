# Research Prompt: MSAL Device-Code Flow Integration

## Objective
Research and document the exact implementation details needed to add MSAL device-code flow authentication as an alternative authentication method for Microsoft accounts in the inbox-zero application, while preserving all existing Better Auth OAuth functionality.

## Context

### Source Implementation (microsoft-mcp)
Location: `/Users/hack/github/microsoft-mcp`

The microsoft-mcp project has a working MSAL device-code flow implementation with:
- **File:** `src/microsoft_mcp/auth_msal.py` - Main MSALRefreshTokenAuth class
- **File:** `src/microsoft_mcp/auth_base.py` - AuthProvider protocol interface
- **File:** `src/microsoft_mcp/auth.py` - Azure SDK alternative auth
- **File:** `authenticate.py` - CLI authentication script
- **File:** `src/microsoft_mcp/graph.py` - Graph API HTTP client

Key Features:
1. Device code flow (headless/CLI-friendly authentication)
2. File-based token storage with secure permissions (0o600)
3. Automatic token refresh via HTTP POST
4. Uses default Microsoft Office client ID (zero-config option)
5. Pluggable via AuthProvider protocol

### Target Codebase (inbox-zero)
Location: `/Users/hack/github/inbox-zero`

Current auth architecture:
- **Framework:** Better Auth 1.4.5 with Prisma adapter
- **File:** `apps/web/utils/auth.ts` - Main auth configuration
- **File:** `apps/web/utils/encryption.ts` - AES-256-GCM token encryption
- **Providers:** Google OAuth, Microsoft OAuth via Better Auth
- **Token Storage:** Encrypted in PostgreSQL (Account table)
- **Sessions:** JWT cookies with 30-day expiration

## Research Questions

### 1. Authentication Flow Integration
- How should device-code flow coexist with Better Auth's Microsoft OAuth?
- What triggers device-code flow vs browser OAuth flow?
- Should this be user-selectable or automatic based on environment?

### 2. Token Storage Strategy
- Should MSAL tokens use inbox-zero's existing encryption system?
- Store in database (like current approach) or file-based (like microsoft-mcp)?
- How to handle token refresh - MSAL library vs custom HTTP refresh?

### 3. Session Management
- How do MSAL-obtained tokens integrate with Better Auth sessions?
- Should device-code auth create a Better Auth session or separate auth path?
- How to handle Account/EmailAccount record creation for MSAL auth?

### 4. API Compatibility
- How does the existing Outlook email provider use tokens?
- What changes needed in `apps/web/utils/outlook/*.ts` files?
- Does Graph API client need modification to support MSAL tokens?

### 5. Configuration
- What new environment variables are needed?
- How to configure client ID/tenant for MSAL?
- Default scopes vs custom scopes for inbox-zero's email features?

## Files to Examine

### microsoft-mcp (Source)
Read and document key patterns from:
1. `/Users/hack/github/microsoft-mcp/src/microsoft_mcp/auth_msal.py`
2. `/Users/hack/github/microsoft-mcp/src/microsoft_mcp/auth_base.py`
3. `/Users/hack/github/microsoft-mcp/authenticate.py`
4. `/Users/hack/github/microsoft-mcp/pyproject.toml` (MSAL dependency)

### inbox-zero (Target)
Examine existing auth integration:
1. `/Users/hack/github/inbox-zero/apps/web/utils/auth.ts`
2. `/Users/hack/github/inbox-zero/apps/web/utils/outlook/client.ts`
3. `/Users/hack/github/inbox-zero/apps/web/utils/outlook/scopes.ts`
4. `/Users/hack/github/inbox-zero/apps/web/utils/outlook/mail.ts`
5. `/Users/hack/github/inbox-zero/apps/web/utils/encryption.ts`
6. `/Users/hack/github/inbox-zero/apps/web/prisma/schema.prisma` (Account model)

## Expected Output

### ResearchPack Structure
```markdown
## MSAL Device-Code Flow Integration - Research Findings

### 1. Implementation Architecture
- Recommended integration approach
- Component interaction diagram

### 2. Key File Mappings
- Source file → Target location mappings
- Conversion requirements (Python → TypeScript)

### 3. Dependencies
- New npm packages needed
- Version compatibility notes

### 4. Token Flow
- Detailed token lifecycle
- Refresh mechanism
- Storage strategy

### 5. Configuration Schema
- Environment variables
- TypeScript types
- Prisma schema changes (if any)

### 6. API Changes
- New endpoints needed
- Existing endpoint modifications
- Client-side changes

### 7. Security Considerations
- Token encryption requirements
- Secure storage approach
- Session implications

### 8. Testing Strategy
- Unit test approach
- Integration test scenarios
- Manual testing checklist
```

## Constraints

1. **Preserve existing functionality** - All current Google OAuth and Microsoft OAuth via Better Auth must continue working
2. **TypeScript implementation** - Port Python concepts to TypeScript/Node.js
3. **Database storage** - Use existing Prisma/PostgreSQL patterns, not file-based storage
4. **Encryption** - Use existing AES-256-GCM encryption from `utils/encryption.ts`
5. **No breaking changes** - Existing users' sessions and accounts must not be affected

## Success Criteria

Research is complete when:
- [ ] All key files from both codebases examined
- [ ] Token flow fully understood and documented
- [ ] Integration approach decided (separate route vs Better Auth plugin)
- [ ] All dependencies identified
- [ ] Security approach validated
- [ ] No gaps in implementation path
