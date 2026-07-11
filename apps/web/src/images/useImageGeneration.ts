import { useCallback, useEffect, useReducer, useRef } from "react";
import { imageApi } from "./imageApi.ts";
import { imageGenerationReducer, initialImageGenerationState } from "./imageGenerationState.ts";
import type { ImageEditInput, ImageGenerationInput } from "./types.ts";

export function useImageGeneration(api = imageApi) {
  const [state, dispatch] = useReducer(imageGenerationReducer, initialImageGenerationState);
  const active = useRef<AbortController | null>(null);
  const run = useCallback(async (input: ImageGenerationInput | ImageEditInput) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const edit = "sourceAssetId" in input;
    dispatch({ type: "submit", operation: edit ? "edit" : "generation" });
    try {
      const result = edit
        ? await api.edit(input, crypto.randomUUID(), controller.signal)
        : await api.generate(input, crypto.randomUUID(), controller.signal);
      if (!controller.signal.aborted) dispatch({ type: "succeed", assets: result.assets });
      return result;
    } catch (error) {
      if (active.current !== controller) return undefined;
      if (controller.signal.aborted) dispatch({ type: "cancel" });
      else {
        dispatch({
          type: "fail",
          error: error instanceof Error ? error.message : "Image generation failed.",
        });
      }
      return undefined;
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [api]);
  const cancel = useCallback(() => active.current?.abort(), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  useEffect(() => () => active.current?.abort(), []);
  return { state, run, cancel, reset };
}
