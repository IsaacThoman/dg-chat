import { Ajv, type ValidateFunction } from "ajv";
import * as addFormatsNamespace from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

const addFormats = addFormatsNamespace.default as unknown as FormatsPlugin;

export interface CompiledToolSchema {
  readonly schema: Record<string, unknown>;
  validate(value: unknown): boolean;
}

type SchemaNode = boolean | Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

function normalizeNode(
  raw: unknown,
  depth: number,
  allowDefaultClosure = true,
  requireExplicitClosure = false,
): SchemaNode {
  if (depth > 48) throw new Error("Tool schema exceeds the nesting limit");
  if (typeof raw === "boolean") return raw;
  if (!isPlainObject(raw)) throw new Error("Tool schema nodes must be objects or booleans");
  if (raw.$async === true) throw new Error("Asynchronous tool schemas are not supported");

  const schema = raw;
  if (
    schema.$schema !== undefined && schema.$schema !== DRAFT_07 &&
    schema.$schema !== `${DRAFT_07.slice(0, -1)}`
  ) throw new Error("Tool schema dialect must be JSON Schema Draft 7");
  if (depth === 0) schema.$schema = DRAFT_07;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const composed = schema.$ref !== undefined || schema.allOf !== undefined ||
    schema.anyOf !== undefined || schema.oneOf !== undefined || schema.if !== undefined ||
    schema.then !== undefined || schema.else !== undefined;
  const objectShaped = types.includes("object") || schema.properties !== undefined;
  if (requireExplicitClosure && objectShaped && schema.additionalProperties === undefined) {
    throw new Error(
      "Tool schema reusable object definitions must declare additionalProperties explicitly",
    );
  }
  if (
    allowDefaultClosure && composed && objectShaped && schema.additionalProperties === undefined
  ) {
    throw new Error(
      "Tool schema composed objects must declare additionalProperties explicitly",
    );
  }
  if (
    allowDefaultClosure && !composed && schema.additionalProperties === undefined &&
    objectShaped
  ) {
    // Tool calls are security boundaries. Object schemas are closed unless their author makes the
    // extension point explicit, including for nested objects.
    schema.additionalProperties = false;
  }

  for (const keyword of ["properties", "patternProperties"] as const) {
    if (schema[keyword] === undefined) continue;
    if (!isPlainObject(schema[keyword])) throw new Error(`Tool schema ${keyword} is invalid`);
    for (const [name, child] of Object.entries(schema[keyword])) {
      schema[keyword][name] = normalizeNode(child, depth + 1);
    }
  }
  for (const keyword of ["$defs", "definitions"] as const) {
    if (schema[keyword] === undefined) continue;
    if (!isPlainObject(schema[keyword])) throw new Error(`Tool schema ${keyword} is invalid`);
    for (const [name, child] of Object.entries(schema[keyword])) {
      schema[keyword][name] = normalizeNode(child, depth + 1, false, true);
    }
  }
  if (schema.dependentSchemas !== undefined) {
    if (!isPlainObject(schema.dependentSchemas)) {
      throw new Error("Tool schema dependentSchemas is invalid");
    }
    for (const [name, child] of Object.entries(schema.dependentSchemas)) {
      schema.dependentSchemas[name] = normalizeNode(child, depth + 1, false);
    }
  }
  if (isPlainObject(schema.dependencies)) {
    for (const [name, child] of Object.entries(schema.dependencies)) {
      if (!Array.isArray(child)) {
        schema.dependencies[name] = normalizeNode(child, depth + 1, false);
      }
    }
  }
  for (
    const keyword of [
      "additionalProperties",
      "additionalItems",
      "contains",
      "propertyNames",
    ] as const
  ) {
    const child = schema[keyword];
    if (child !== undefined && typeof child !== "boolean") {
      schema[keyword] = normalizeNode(child, depth + 1);
    }
  }
  for (const keyword of ["not", "if", "then", "else"] as const) {
    const child = schema[keyword];
    if (child !== undefined) schema[keyword] = normalizeNode(child, depth + 1, false);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const children = schema[keyword];
    if (children === undefined) continue;
    if (!Array.isArray(children)) throw new Error(`Tool schema ${keyword} is invalid`);
    // Closing each branch independently changes allOf/anyOf semantics by making sibling fields
    // mutually illegal. Composed object schemas must state additionalProperties explicitly.
    schema[keyword] = children.map((child) => normalizeNode(child, depth + 1, false));
  }
  if (schema.items !== undefined) {
    schema.items = Array.isArray(schema.items)
      ? schema.items.map((child) => normalizeNode(child, depth + 1))
      : normalizeNode(schema.items, depth + 1);
  }
  return schema;
}

function compile(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv({
    strict: true,
    allowUnionTypes: true,
    allErrors: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    ownProperties: true,
  });
  addFormats(ajv, { mode: "full" });
  return ajv.compile(schema);
}

/**
 * Compile JSON Schema Draft 7 once at registration. Common ajv-formats are enforced and validation
 * never mutates tool input; other dialects and unknown formats fail closed.
 */
export function compileToolInputSchema(raw: Record<string, unknown>): CompiledToolSchema {
  let schema: Record<string, unknown>;
  try {
    schema = structuredClone(raw);
    if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > 256_000) {
      throw new Error("Tool schema exceeds the size limit");
    }
    schema = normalizeNode(schema, 0) as Record<string, unknown>;
    const serialized = new TextEncoder().encode(JSON.stringify(schema));
    if (serialized.byteLength > 256_000) throw new Error("Tool schema exceeds the size limit");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Tool schema")) throw error;
    throw new Error("Tool schema must be bounded JSON");
  }
  try {
    const validator = compile(schema);
    return { schema, validate: (value) => validator(value) === true };
  } catch {
    // Schema compiler details may echo remote references or embedded literals. Registration errors
    // stay categorical so secrets accidentally placed in a schema cannot reach logs or clients.
    throw new Error("Tool schema is invalid or uses unsupported keywords");
  }
}
