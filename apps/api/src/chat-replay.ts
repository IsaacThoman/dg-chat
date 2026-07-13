const PUBLIC_CHAT_PAYLOAD_BYTES = 4 * 1024 * 1024;
const CHAT_PUBLIC_ENVELOPE_BYTES = 65_536;
const CHAT_TERMINAL_REPLAY_BYTES = 65_536;
const CHAT_EVENT_PROJECTION_OVERHEAD_BYTES = 4_096;

/** A successful buffered public Chat payload first passes the 4 MiB protocol clone boundary. */
export function maximumBufferedChatReplayBytes(): number {
  return PUBLIC_CHAT_PAYLOAD_BYTES + CHAT_PUBLIC_ENVELOPE_BYTES;
}

/**
 * Bounds normalized public Chat SSE before provider dispatch. Public projection is an allowlisted
 * subset of the transport payload, while the per-event allowance covers normalized defaults plus
 * the gateway-owned identity and SSE envelope.
 */
export function maximumLiveChatStreamReplayBytes(
  providerResponseBytes: number,
  maximumLiveFragments: number,
): number {
  if (
    !Number.isSafeInteger(providerResponseBytes) || providerResponseBytes < 1 ||
    !Number.isSafeInteger(maximumLiveFragments) || maximumLiveFragments < 1
  ) throw new TypeError("Chat replay bounds require positive safe integers");
  const total = BigInt(providerResponseBytes) +
    BigInt(maximumLiveFragments) * BigInt(CHAT_EVENT_PROJECTION_OVERHEAD_BYTES);
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total);
}

export function maximumChatStreamReplayBytes(
  providerResponseBytes: number,
  maximumLiveFragments: number,
): number {
  const live = maximumLiveChatStreamReplayBytes(providerResponseBytes, maximumLiveFragments);
  return live > Number.MAX_SAFE_INTEGER - CHAT_TERMINAL_REPLAY_BYTES
    ? Number.MAX_SAFE_INTEGER
    : live + CHAT_TERMINAL_REPLAY_BYTES;
}

export const CHAT_STREAM_TERMINAL_REPLAY_BYTES = CHAT_TERMINAL_REPLAY_BYTES;
