"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { toastSuccess, toastError } from "@/components/Toast";
import { CheckCircle, Clipboard, AlertTriangle, Loader2 } from "lucide-react";

type FlowState = "idle" | "initiated" | "polling" | "complete" | "error";

interface DeviceCodeResponse {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  message: string;
}

interface PollResponse {
  status: "pending" | "complete" | "expired" | "error";
  email?: string;
  error?: string;
  message?: string;
  redirectUrl?: string;
}

interface DeviceCodeLoginProps {
  onComplete?: () => void;
}

export function DeviceCodeLogin({ onComplete }: DeviceCodeLoginProps) {
  const {
    flowState,
    deviceCode,
    error,
    copied,
    initiateFlow,
    copyCode,
    reset,
  } = useDeviceCodeFlow({ onComplete });

  return (
    <div className="space-y-4">
      {flowState === "idle" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This method is useful when browser-based sign-in isn&apos;t
            available. You&apos;ll get a code to enter on Microsoft&apos;s
            website.
          </p>
          <Button onClick={initiateFlow} className="w-full">
            Start Device Code Flow
          </Button>
        </div>
      )}

      {flowState === "initiated" && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {(flowState === "polling" || flowState === "complete") && deviceCode && (
        <div className="space-y-4">
          <div className="rounded-lg bg-muted p-4">
            <p className="mb-2 text-sm font-medium text-muted-foreground">
              Step 1: Copy your code
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-background px-3 py-2 font-mono text-xl font-bold tracking-wider">
                {deviceCode.userCode}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={copyCode}
                className="shrink-0"
              >
                {copied ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <Clipboard className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-muted p-4">
            <p className="mb-2 text-sm font-medium text-muted-foreground">
              Step 2: Open Microsoft login
            </p>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => window.open(deviceCode.verificationUri, "_blank")}
            >
              Open {deviceCode.verificationUri}
            </Button>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {flowState === "polling" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Waiting for you to complete sign-in...</span>
              </>
            ) : (
              <>
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span>Authentication complete! Redirecting...</span>
              </>
            )}
          </div>
        </div>
      )}

      {flowState === "error" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-destructive/10 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">
                Authentication Failed
              </p>
              <p className="text-sm text-destructive/80">{error}</p>
            </div>
          </div>
          <Button onClick={reset} variant="outline" className="w-full">
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}

function useDeviceCodeFlow({ onComplete }: { onComplete?: () => void }) {
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [deviceCode, setDeviceCode] = useState<DeviceCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    pollInFlightRef.current = false;
    activeSessionIdRef.current = null;
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const poll = useCallback(
    async (sessionId: string) => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;

      try {
        const response = await fetch("/api/outlook/device-code/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });

        const data: PollResponse = await response.json();

        if (activeSessionIdRef.current !== sessionId) return;

        if (data.status === "complete") {
          cleanup();
          setFlowState("complete");
          toastSuccess({
            description: data.message || "Authentication successful!",
          });

          setTimeout(() => {
            onComplete?.();
            window.location.href = data.redirectUrl || "/welcome";
          }, 1500);
          return;
        }

        if (data.status === "expired") {
          cleanup();
          setError("The device code has expired. Please try again.");
          setFlowState("error");
          return;
        }

        if (data.status === "error") {
          cleanup();
          setError(data.error || "Authentication failed");
          setFlowState("error");
          return;
        }

        pollTimeoutRef.current = setTimeout(() => {
          poll(sessionId);
        }, 3000);
      } catch (_err) {
        cleanup();
        setError("Failed to check authentication status");
        setFlowState("error");
      } finally {
        pollInFlightRef.current = false;
      }
    },
    [cleanup, onComplete],
  );

  const initiateFlow = useCallback(async () => {
    setFlowState("initiated");
    setError(null);
    setDeviceCode(null);

    try {
      const response = await fetch("/api/outlook/device-code/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to initiate device code flow");
      }

      const data: DeviceCodeResponse = await response.json();
      setDeviceCode(data);
      setFlowState("polling");
      activeSessionIdRef.current = data.sessionId;

      pollTimeoutRef.current = setTimeout(() => {
        poll(data.sessionId);
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setFlowState("error");
    }
  }, [poll]);

  const copyCode = useCallback(async () => {
    if (!deviceCode) return;

    try {
      await navigator.clipboard.writeText(deviceCode.userCode);
      setCopied(true);
      toastSuccess({ description: "Code copied to clipboard!" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError({ description: "Failed to copy code" });
    }
  }, [deviceCode]);

  const reset = useCallback(() => {
    cleanup();
    setFlowState("idle");
    setDeviceCode(null);
    setError(null);
    setCopied(false);
  }, [cleanup]);

  return {
    flowState,
    deviceCode,
    error,
    copied,
    initiateFlow,
    copyCode,
    reset,
  };
}
