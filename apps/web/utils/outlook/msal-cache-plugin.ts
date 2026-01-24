/**
 * MSAL Token Cache Persistence Plugin
 *
 * Implements ICachePlugin to persist MSAL's token cache to PostgreSQL.
 * This enables device-code authenticated accounts to refresh tokens
 * after server restarts.
 *
 * The cache is stored encrypted in the Account.msal_cache field.
 */

import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import prisma from "@/utils/prisma";
import { encryptToken, decryptToken } from "@/utils/encryption";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("msal-cache-plugin");

/**
 * Creates a Prisma-backed cache plugin for MSAL
 * Each instance is scoped to a specific Microsoft account (providerAccountId)
 */
export function createPrismaCachePlugin(
  providerAccountId: string,
): ICachePlugin {
  return {
    /**
     * Called before MSAL accesses the token cache
     * Loads the cache from the database if it exists
     */
    async beforeCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
      try {
        const account = await prisma.account.findFirst({
          where: {
            provider: "microsoft",
            providerAccountId,
          },
          select: { msal_cache: true },
        });

        if (account?.msal_cache) {
          const decrypted = decryptToken(account.msal_cache);
          if (decrypted) {
            cacheContext.tokenCache.deserialize(decrypted);
            logger.info("Loaded MSAL cache from database", { providerAccountId });
          } else {
            logger.warn("Failed to decrypt MSAL cache", { providerAccountId });
          }
        }
      } catch (error) {
        logger.error("Failed to load MSAL cache from database", {
          providerAccountId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't throw - allow MSAL to continue with empty cache
        // User will need to re-authenticate if cache can't be loaded
      }
    },

    /**
     * Called after MSAL modifies the token cache
     * Persists the cache to the database if it has changed
     */
    async afterCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
      if (!cacheContext.cacheHasChanged) {
        return;
      }

      try {
        const serialized = cacheContext.tokenCache.serialize();
        const encrypted = encryptToken(serialized);

        if (!encrypted) {
          logger.error("Failed to encrypt MSAL cache", { providerAccountId });
          return;
        }

        await prisma.account.updateMany({
          where: {
            provider: "microsoft",
            providerAccountId,
          },
          data: {
            msal_cache: encrypted,
            msal_cache_updated: new Date(),
          },
        });

        logger.info("Persisted MSAL cache to database", { providerAccountId });
      } catch (error) {
        logger.error("Failed to persist MSAL cache to database", {
          providerAccountId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't throw - cache will be re-populated on next successful token acquisition
      }
    },
  };
}

/**
 * Extracts the refresh token from a stored MSAL cache
 * Used as a fallback when MSAL silent acquisition fails but we have a stored cache
 *
 * MSAL cache JSON structure:
 * {
 *   "Account": { ... },
 *   "AccessToken": { ... },
 *   "RefreshToken": {
 *     "cache-key": {
 *       "secret": "actual-refresh-token",
 *       "home_account_id": "...",
 *       ...
 *     }
 *   },
 *   "IdToken": { ... }
 * }
 */
export async function extractRefreshTokenFromCache(
  providerAccountId: string,
): Promise<string | null> {
  try {
    const account = await prisma.account.findFirst({
      where: {
        provider: "microsoft",
        providerAccountId,
      },
      select: { msal_cache: true },
    });

    if (!account?.msal_cache) {
      logger.info("No MSAL cache found for account", { providerAccountId });
      return null;
    }

    const decrypted = decryptToken(account.msal_cache);
    if (!decrypted) {
      logger.warn("Failed to decrypt MSAL cache", { providerAccountId });
      return null;
    }

    const cache = JSON.parse(decrypted) as {
      RefreshToken?: Record<string, { secret?: string; home_account_id?: string }>;
    };
    const refreshTokens = cache.RefreshToken || {};

    // Find refresh token for this account
    // The cache key format is: {home_account_id}-{environment}-refreshtoken-{client_id}--
    for (const key of Object.keys(refreshTokens)) {
      const tokenEntry = refreshTokens[key];
      // Match by home_account_id containing the providerAccountId
      if (
        tokenEntry?.secret &&
        (key.toLowerCase().includes(providerAccountId.toLowerCase()) ||
          tokenEntry.home_account_id?.includes(providerAccountId))
      ) {
        logger.info("Found refresh token in MSAL cache", { providerAccountId });
        return tokenEntry.secret;
      }
    }

    // Fallback: return first available refresh token if only one account
    const tokenEntries = Object.values(refreshTokens);
    if (tokenEntries.length === 1 && tokenEntries[0]?.secret) {
      logger.info("Using single refresh token from MSAL cache", { providerAccountId });
      return tokenEntries[0].secret;
    }

    logger.warn("No matching refresh token found in MSAL cache", {
      providerAccountId,
      tokenCount: tokenEntries.length,
    });
    return null;
  } catch (error) {
    logger.error("Failed to extract refresh token from MSAL cache", {
      providerAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Updates the refresh token in a stored MSAL cache
 * Called after a direct OAuth2 token refresh to keep the cache in sync
 */
export async function updateRefreshTokenInCache(
  providerAccountId: string,
  newRefreshToken: string,
): Promise<void> {
  try {
    const account = await prisma.account.findFirst({
      where: {
        provider: "microsoft",
        providerAccountId,
      },
      select: { msal_cache: true },
    });

    if (!account?.msal_cache) {
      logger.info("No MSAL cache to update", { providerAccountId });
      return;
    }

    const decrypted = decryptToken(account.msal_cache);
    if (!decrypted) {
      logger.warn("Failed to decrypt MSAL cache for update", { providerAccountId });
      return;
    }

    const cache = JSON.parse(decrypted) as {
      RefreshToken?: Record<string, { secret?: string }>;
    };
    const refreshTokens = cache.RefreshToken || {};

    // Update all refresh token entries for this account
    let updated = false;
    for (const key of Object.keys(refreshTokens)) {
      if (
        key.toLowerCase().includes(providerAccountId.toLowerCase()) ||
        Object.keys(refreshTokens).length === 1
      ) {
        if (refreshTokens[key]) {
          refreshTokens[key].secret = newRefreshToken;
          updated = true;
        }
      }
    }

    if (!updated) {
      logger.warn("No refresh token entry to update in MSAL cache", { providerAccountId });
      return;
    }

    cache.RefreshToken = refreshTokens;
    const encrypted = encryptToken(JSON.stringify(cache));

    if (!encrypted) {
      logger.error("Failed to encrypt updated MSAL cache", { providerAccountId });
      return;
    }

    await prisma.account.updateMany({
      where: {
        provider: "microsoft",
        providerAccountId,
      },
      data: {
        msal_cache: encrypted,
        msal_cache_updated: new Date(),
      },
    });

    logger.info("Updated refresh token in MSAL cache", { providerAccountId });
  } catch (error) {
    logger.error("Failed to update refresh token in MSAL cache", {
      providerAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
