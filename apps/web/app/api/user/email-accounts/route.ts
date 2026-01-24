import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withAuth } from "@/utils/middleware";

export type GetEmailAccountsResponse = Awaited<
  ReturnType<typeof getEmailAccounts>
>;

async function getEmailAccounts({ userId }: { userId: string }) {
  const emailAccounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: {
      id: true,
      email: true,
      accountId: true,
      name: true,
      image: true,
      account: {
        select: {
          provider: true,
          providerAccountId: true,
          refresh_token: true,
        },
      },
      user: {
        select: {
          name: true,
          image: true,
          email: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  const accountsWithNames = emailAccounts.map((emailAccount) => {
    // Compute if this is a device-code authenticated account
    // Device-code accounts have refresh_token = null with microsoft provider
    const isDeviceCodeAuth =
      emailAccount.account?.provider === "microsoft" &&
      !emailAccount.account?.refresh_token;

    // Extract providerAccountId for MSAL token lookup
    const providerAccountId = emailAccount.account?.providerAccountId || null;

    // Remove refresh_token from the response (security - don't expose to client)
    const { refresh_token: _refreshToken, ...accountWithoutToken } =
      emailAccount.account || {};

    // Old accounts don't have a name attached, so use the name from the user
    if (emailAccount.user.email === emailAccount.email) {
      return {
        ...emailAccount,
        account: accountWithoutToken,
        name: emailAccount.name || emailAccount.user.name,
        image: emailAccount.image || emailAccount.user.image,
        isPrimary: true,
        isDeviceCodeAuth,
        providerAccountId,
      };
    }

    return {
      ...emailAccount,
      account: accountWithoutToken,
      isPrimary: false,
      isDeviceCodeAuth,
      providerAccountId,
    };
  });

  return { emailAccounts: accountsWithNames };
}

export const GET = withAuth("user/email-accounts", async (request) => {
  const userId = request.auth.userId;
  const result = await getEmailAccounts({ userId });
  return NextResponse.json(result);
});
