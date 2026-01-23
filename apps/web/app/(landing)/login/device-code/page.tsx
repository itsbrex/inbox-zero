import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DeviceCodeLogin } from "@/app/(landing)/login/DeviceCodeLogin";
import { auth } from "@/utils/auth";
import { WELCOME_PATH } from "@/utils/config";

export const metadata: Metadata = {
  title: "Device Code Sign In | Inbox Zero",
  description: "Sign in using a Microsoft device code.",
  alternates: { canonical: "/login/device-code" },
};

export default async function DeviceCodeLoginPage() {
  const session = await auth();
  if (session?.user) {
    redirect(WELCOME_PATH);
  }

  return (
    <div className="flex h-screen flex-col justify-center text-foreground">
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[420px]">
        <div className="flex flex-col text-center">
          <h1 className="font-title text-2xl text-foreground">
            Device Code Sign In
          </h1>
          <p className="mt-4 text-muted-foreground">
            Use a device code to sign in with your Microsoft account.
          </p>
        </div>

        <div className="mt-4">
          <DeviceCodeLogin />
        </div>

        <Button variant="ghost" size="lg" asChild>
          <Link href="/login">Back to login</Link>
        </Button>
      </div>
    </div>
  );
}
