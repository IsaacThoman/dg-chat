import { assertEquals } from "jsr:@std/assert@1.0.14";
import {
  openAIParameterFromSegments,
  openAIParameterFromZodIssues,
  safeOpenAIParameter,
} from "./openai-parameter.ts";

Deno.test("OpenAI parameter paths preserve safe validator fields and array indexes", () => {
  assertEquals(
    openAIParameterFromSegments(["messages", 0, "content", 2, "type"]),
    "messages[0].content[2].type",
  );
  assertEquals(
    safeOpenAIParameter("request.input[12].content[3].image_url"),
    "request.input[12].content[3].image_url",
  );
});

Deno.test("OpenAI parameter paths fail closed for hostile or oversized segments", () => {
  for (
    const path of [
      ["messages", Symbol("secret")],
      ["messages", -1],
      ["messages", 1_000_001],
      ["__proto__", "secret"],
      ["messages", "x".repeat(65)],
      Array.from({ length: 33 }, () => "field"),
    ] as const
  ) assertEquals(openAIParameterFromSegments(path), null);

  for (
    const path of [
      "request.input[0]['secret']",
      "request.input[-1]",
      "request.input[0001]",
      "request.__proto__.secret",
      "request.input\r\nx-leak: yes",
      `request.${"x".repeat(257)}`,
      Array.from({ length: 33 }, () => "field").join("."),
    ]
  ) assertEquals(safeOpenAIParameter(path), null);
});

Deno.test("OpenAI parameter paths select the most specific safe union issue", () => {
  assertEquals(
    openAIParameterFromZodIssues([{
      path: ["input"],
      errors: [
        [{ path: [] }],
        [{
          path: [0],
          errors: [
            [{ path: ["role"] }],
            [{ path: ["type"] }, { path: ["call_id"] }],
          ],
        }],
      ],
    }]),
    "input[0].role",
  );
  assertEquals(
    openAIParameterFromZodIssues([{
      path: ["input"],
      errors: [[{ path: ["__proto__", "secret"] }]],
    }]),
    "input",
  );
});
