import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  CHAT_STREAM_TERMINAL_REPLAY_BYTES,
  maximumBufferedChatReplayBytes,
  maximumChatStreamReplayBytes,
  maximumLiveChatStreamReplayBytes,
} from "./chat-replay.ts";
import { publicChatStreamChunk } from "./provider-protocol.ts";

Deno.test("Chat replay bounds scale with provider transport and retain terminal capacity", () => {
  const live = maximumLiveChatStreamReplayBytes(16 * 1024 * 1024, 8_191);
  assertEquals(live, 50_327_552);
  assertEquals(
    maximumChatStreamReplayBytes(16 * 1024 * 1024, 8_191),
    live + CHAT_STREAM_TERMINAL_REPLAY_BYTES,
  );
  assertEquals(maximumBufferedChatReplayBytes(), 4_259_840);
  assertEquals(
    maximumChatStreamReplayBytes(64 * 1024 * 1024, 8_191) >
      maximumChatStreamReplayBytes(16 * 1024 * 1024, 8_191),
    true,
  );
  assertThrows(() => maximumLiveChatStreamReplayBytes(0, 1), TypeError);
});

Deno.test("public Chat stream projection expansion fits the per-event replay allowance", () => {
  const variants = [
    {
      id: "x",
      object: "chat.completion.chunk",
      created: 1,
      model: "x",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    {
      id: "x",
      object: "chat.completion.chunk",
      created: 1,
      model: "x",
      choices: [{
        index: 0,
        delta: {
          tool_calls: Array.from({ length: 128 }, (_, index) => ({ index })),
        },
        finish_reason: null,
      }],
    },
  ];
  const encoder = new TextEncoder();
  for (const input of variants) {
    const projected = publicChatStreamChunk(
      input,
      `chatcmpl-${"x".repeat(64)}`,
      "public/" + "m".repeat(193),
    );
    const expansion = encoder.encode(JSON.stringify(projected)).byteLength -
      encoder.encode(JSON.stringify(input)).byteLength;
    assertEquals(expansion <= 4_096, true);
  }
});
