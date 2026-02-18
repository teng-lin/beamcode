import { useStore } from "../store";

export function AuthBanner({ sessionId }: { sessionId: string }) {
  const authStatus = useStore((s) => s.sessionData[sessionId]?.authStatus);
  if (!authStatus || (!authStatus.isAuthenticating && !authStatus.error)) return null;

  return (
    <div
      className={`border-b px-3 py-2 text-xs ${
        authStatus.error
          ? "border-bc-error/20 bg-bc-error/10 text-bc-error"
          : "border-bc-accent/20 bg-bc-accent/10 text-bc-accent"
      }`}
      role="alert"
    >
      <div className="flex items-center gap-2">
        {authStatus.isAuthenticating && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bc-accent" />
        )}
        <span className="font-medium">
          {authStatus.error ? "Authentication failed" : "Authenticating..."}
        </span>
      </div>
      {authStatus.output.length > 0 && (
        <pre className="mt-1 font-mono-code text-[11px] opacity-80">
          {authStatus.output.join("\n")}
        </pre>
      )}
      {authStatus.error && <p className="mt-1">{authStatus.error}</p>}
    </div>
  );
}
