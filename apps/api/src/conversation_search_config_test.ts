import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import {
  conversationSearchConcurrencyLeaseMs,
  DEFAULT_CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS,
} from "./conversation-search-config.ts";

Deno.test("conversation search admission lease defaults to fifteen seconds", () => {
  assertEquals(
    conversationSearchConcurrencyLeaseMs(),
    DEFAULT_CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS * 1_000,
  );
  assertEquals(conversationSearchConcurrencyLeaseMs("6"), 6_000);
  assertEquals(conversationSearchConcurrencyLeaseMs("60"), 60_000);
});

Deno.test("conversation search admission lease must safely exceed the database deadline", () => {
  for (const value of ["", "0", "5", "5.1", "61", "nope"]) {
    assertThrows(
      () => conversationSearchConcurrencyLeaseMs(value),
      Error,
      "CONVERSATION_SEARCH_CONCURRENCY_LEASE_SECONDS",
    );
  }
});
