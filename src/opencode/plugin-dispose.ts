/**
 * OpenCode Plugin Teardown
 *
 * Extracted, testable teardown for the OpenCode plugin. Ends the current
 * session and — only when no other active sessions remain — stops the
 * dashboard and sidecar.
 *
 * OpenCode 1.18.3 does NOT expose a native `dispose` plugin hook (verified in
 * the 2026-07-17 capability spike; the shipped `@opencode-ai/plugin` `Hooks`
 * interface has no `dispose` key, and the V2/Promise plugin API that carries a
 * `Registration.dispose` is not surfaced to plugin authors). So this runs from
 * the `session.deleted` branch today, but is factored out so it can be wired to
 * a native `dispose` hook the moment one becomes available.
 *
 * Fail-safe: never throws. If we cannot confirm zero active sessions, we do NOT
 * stop the shared sidecar/dashboard (another session may still be using it).
 */

export interface DisposeDeps {
  /** The session being torn down. When absent, dispose is a no-op. */
  sessionId: string | undefined;
  /** End the session in the sidecar. */
  endSession: (sessionId: string) => Promise<void>;
  /** List remaining active sessions (used to decide shared-resource shutdown). */
  getActiveSessions: () => Promise<Array<{ id: string }>>;
  /** Stop the dashboard process (only when no active sessions remain). */
  stopDashboard: () => void;
  /** Stop the sidecar process (only when no active sessions remain). */
  stopSidecar: () => void;
  /** Optional logger. */
  log?: (message: string) => void;
}

/**
 * Tear down the current session; stop shared sidecar/dashboard iff it's the
 * last active session. Never throws.
 */
export async function disposePlugin(deps: DisposeDeps): Promise<void> {
  const { sessionId, log } = deps;
  if (!sessionId) return;

  try {
    await deps.endSession(sessionId);
  } catch (e) {
    log?.(`dispose: endSession failed: ${e instanceof Error ? e.message : e}`);
    // Continue — we still attempt the active-session check below only if it's safe.
  }

  try {
    const active = await deps.getActiveSessions();
    if (active.length === 0) {
      deps.stopDashboard();
      deps.stopSidecar();
    }
  } catch (e) {
    // Could not confirm zero active sessions → do NOT stop shared resources.
    log?.(
      `dispose: active-session check failed, leaving sidecar running: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}
