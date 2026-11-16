/**
 * Runs once when a Next.js server instance starts, before it serves requests.
 * Node-only startup checks live in ./instrumentation-node (Next.js docs: import
 * runtime-specific code conditionally on NEXT_RUNTIME).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
