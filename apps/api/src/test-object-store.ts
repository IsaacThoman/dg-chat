import type { ObjectStore, PutObjectInput, StoredObject } from "@dg-chat/database";
import { ObjectAlreadyExistsError } from "@dg-chat/database";

interface MemoryObject {
  bytes: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
}

/** Small test double that still drains upload streams, so route tests exercise streaming I/O. */
export class TestObjectStore implements ObjectStore {
  readonly objects = new Map<string, MemoryObject>();

  async put(input: PutObjectInput) {
    if (this.objects.has(input.key)) throw new ObjectAlreadyExistsError(input.key);
    const bytes = new Uint8Array(await new Response(input.body).arrayBuffer());
    if (bytes.byteLength !== input.contentLength) throw new Error("content length mismatch");
    this.objects.set(input.key, {
      bytes,
      contentType: input.contentType,
      metadata: { ...input.metadata },
    });
    return { etag: `test-${bytes.byteLength}` };
  }

  get(key: string): Promise<StoredObject | undefined> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object
        ? {
          key,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(object.bytes.slice());
              controller.close();
            },
          }),
          contentLength: object.bytes.byteLength,
          contentType: object.contentType,
          etag: `test-${object.bytes.byteLength}`,
          metadata: { ...object.metadata },
        }
        : undefined,
    );
  }

  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }

  readiness() {
    return Promise.resolve(true);
  }

  close() {}
}
