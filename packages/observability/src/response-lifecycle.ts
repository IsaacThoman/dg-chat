export type ResponseLifecycleOutcome = "completed" | "cancelled" | "failed";

/**
 * Preserve response bytes and backpressure while observing the terminal body lifecycle exactly
 * once. Error details and cancellation reasons are propagated to the stream consumer/source but
 * never passed to the observer.
 */
export function observeResponseLifecycle(
  response: Response,
  transmitBody: boolean,
  onSettled: (outcome: ResponseLifecycleOutcome) => void,
): Response {
  let settled = false;
  const settle = (outcome: ResponseLifecycleOutcome) => {
    if (settled) return;
    settled = true;
    // Lifecycle observers are diagnostic side effects. A broken exporter or callback must never
    // alter response bytes, status, cancellation propagation, or stream completion.
    try {
      onSettled(outcome);
    } catch {
      // Deliberately fail open for the response path.
    }
  };

  if (!transmitBody) {
    // Deno does not consume an application-created HEAD body. Cancel it explicitly so generators,
    // file handles, and provider streams cannot remain live after the headers have completed.
    if (response.body !== null) {
      void response.body.cancel("head_response_body_not_transmitted").catch(() => undefined);
    }
    settle("completed");
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (response.body === null) {
    settle("completed");
    return response;
  }

  const reader = response.body.getReader();
  let readerReleased = false;
  let cancelled = false;
  const releaseReader = () => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          settle("completed");
          releaseReader();
          if (!cancelled) controller.close();
          return;
        }
        if (!cancelled) controller.enqueue(chunk.value);
      } catch (error) {
        settle("failed");
        releaseReader();
        if (!cancelled) controller.error(error);
      }
    },
    cancel(reason) {
      // Settle synchronously even if a hostile or broken upstream body never resolves cancellation.
      cancelled = true;
      settle("cancelled");
      return reader.cancel(reason).finally(releaseReader);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
