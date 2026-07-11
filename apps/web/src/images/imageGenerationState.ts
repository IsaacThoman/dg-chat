import type { GeneratedAsset, ImageOperation } from "./types.ts";

export type ImageGenerationState =
  | { phase: "idle"; assets: GeneratedAsset[]; error: null }
  | { phase: "submitting"; assets: GeneratedAsset[]; error: null; operation: ImageOperation }
  | { phase: "success"; assets: GeneratedAsset[]; error: null }
  | { phase: "error"; assets: GeneratedAsset[]; error: string }
  | { phase: "cancelled"; assets: GeneratedAsset[]; error: null };

export type ImageGenerationAction =
  | { type: "submit"; operation: ImageOperation }
  | { type: "succeed"; assets: GeneratedAsset[] }
  | { type: "fail"; error: string }
  | { type: "cancel" }
  | { type: "reset" };

export const initialImageGenerationState: ImageGenerationState = {
  phase: "idle",
  assets: [],
  error: null,
};

export function imageGenerationReducer(
  state: ImageGenerationState,
  action: ImageGenerationAction,
): ImageGenerationState {
  switch (action.type) {
    case "submit":
      return {
        phase: "submitting",
        assets: state.assets,
        error: null,
        operation: action.operation,
      };
    case "succeed":
      return { phase: "success", assets: action.assets, error: null };
    case "fail":
      return { phase: "error", assets: state.assets, error: action.error };
    case "cancel":
      return { phase: "cancelled", assets: state.assets, error: null };
    case "reset":
      return initialImageGenerationState;
  }
}
