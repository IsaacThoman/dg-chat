import { FormEvent, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, RefreshCw, Square, Upload, X } from "lucide-react";
import { Modal } from "../Modal.tsx";
import { ImageResultGrid } from "./ImageCard.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { restoreGeneratedAssetFocus } from "./imageHistory.ts";
import { imageMaskValidationError, shouldCleanupImageMask } from "./imageEditState.ts";
import type { GeneratedAsset, ImageEditInput, ImageGenerationInput } from "./types.ts";
import type { ImageGenerationState } from "./imageGenerationState.ts";

export function ImageGenerationSheet({
  models,
  source,
  state,
  close,
  submit,
  cancel,
  add,
  edit,
  selectedIds = new Set<string>(),
  uploadMask,
  removeMask,
}: {
  models: Array<{ id: string; name: string }>;
  source?: GeneratedAsset;
  state: ImageGenerationState;
  close: () => void;
  submit: (input: ImageGenerationInput | ImageEditInput) => void;
  cancel: () => void;
  add?: (asset: GeneratedAsset) => void;
  edit?: (asset: GeneratedAsset) => void;
  selectedIds?: ReadonlySet<string>;
  uploadMask?: (
    file: File,
    progress: (value: number) => void,
    signal: AbortSignal,
  ) => Promise<{ id: string; filename: string; state?: string }>;
  removeMask?: (attachmentId: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [size, setSize] = useState("1024x1024");
  const [count, setCount] = useState(1);
  const [preview, setPreview] = useState<string | null>(null);
  const [maskFile, setMaskFile] = useState<File>();
  const [maskPreview, setMaskPreview] = useState("");
  const [maskAttachment, setMaskAttachment] = useState<{ id: string; filename: string }>();
  const [maskProgress, setMaskProgress] = useState(0);
  const [maskError, setMaskError] = useState("");
  const [maskUploading, setMaskUploading] = useState(false);
  const [maskRemoving, setMaskRemoving] = useState(false);
  const [maskCleanupFailed, setMaskCleanupFailed] = useState(false);
  const [replacementFailed, setReplacementFailed] = useState(false);
  const maskController = useRef<AbortController | null>(null);
  const maskInput = useRef<HTMLInputElement>(null);
  const submittedMaskId = useRef<string | undefined>(undefined);
  const consumedMaskIds = useRef(new Set<string>());
  const closePreview = () => {
    const id = preview;
    setPreview(null);
    if (id) requestAnimationFrame(() => restoreGeneratedAssetFocus(document, id));
  };
  const closeSheet = async () => {
    maskController.current?.abort();
    setMaskUploading(false);
    if (shouldCleanupImageMask(maskAttachment?.id, consumedMaskIds.current)) {
      if (removeMask) {
        setMaskRemoving(true);
        try {
          await removeMask(maskAttachment.id);
        } catch (error) {
          setMaskError(error instanceof Error ? error.message : "Couldn’t clean up the mask.");
          setMaskCleanupFailed(true);
          setMaskRemoving(false);
          return;
        }
      }
    }
    close();
  };
  useEffect(() => setPrompt(""), [source?.id]);
  useEffect(() => () => maskController.current?.abort(), []);
  useEffect(() => () => {
    if (maskPreview) URL.revokeObjectURL(maskPreview);
  }, [maskPreview]);
  useEffect(() => {
    if (state.phase === "success" && submittedMaskId.current) {
      consumedMaskIds.current.add(submittedMaskId.current);
      submittedMaskId.current = undefined;
    } else if (state.phase === "error" || state.phase === "cancelled") {
      submittedMaskId.current = undefined;
    }
  }, [state.phase]);
  useEffect(() => {
    if (!models.some((item) => item.id === model)) setModel(models[0]?.id ?? "");
  }, [model, models]);
  const busy = state.phase === "submitting";
  const beginMaskUpload = (file: File) => {
    if (!uploadMask) return;
    const validationError = imageMaskValidationError(file);
    if (validationError) {
      setMaskError(validationError);
      return;
    }
    maskController.current?.abort();
    const previousFile = maskFile;
    const previousAttachment = maskAttachment;
    const controller = new AbortController();
    maskController.current = controller;
    if (maskPreview) URL.revokeObjectURL(maskPreview);
    setMaskPreview(URL.createObjectURL(file));
    setMaskFile(file);
    setMaskProgress(0);
    setMaskError("");
    setMaskCleanupFailed(false);
    setReplacementFailed(false);
    setMaskUploading(true);
    void uploadMask(file, setMaskProgress, controller.signal).then(async (attachment) => {
      if (controller.signal.aborted) return;
      if (attachment.state && attachment.state !== "ready") {
        await removeMask?.(attachment.id).catch(() => {});
        throw new Error(`Mask upload is ${attachment.state}; only ready PNG masks can be used.`);
      }
      const previous = maskAttachment;
      setMaskAttachment(attachment);
      if (
        previous && previous.id !== attachment.id &&
        shouldCleanupImageMask(previous.id, consumedMaskIds.current)
      ) {
        await removeMask?.(previous.id).catch(() => {});
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        if (previousAttachment && previousFile) {
          setMaskFile(previousFile);
          setMaskPreview(URL.createObjectURL(previousFile));
          setReplacementFailed(true);
          setMaskError(
            `Replacement failed. The previous mask is still selected. ${
              error instanceof Error ? error.message : "Mask upload failed."
            }`,
          );
        } else setMaskError(error instanceof Error ? error.message : "Mask upload failed.");
      }
    }).finally(() => {
      if (maskController.current === controller) {
        maskController.current = null;
        setMaskUploading(false);
      }
    });
  };
  const clearMask = async () => {
    maskController.current?.abort();
    maskController.current = null;
    setMaskUploading(false);
    const attachment = maskAttachment;
    const file = maskFile;
    setMaskFile(undefined);
    if (maskPreview) URL.revokeObjectURL(maskPreview);
    setMaskPreview("");
    setMaskAttachment(undefined);
    setMaskProgress(0);
    setMaskError("");
    setMaskCleanupFailed(false);
    setReplacementFailed(false);
    if (
      attachment && removeMask && shouldCleanupImageMask(attachment.id, consumedMaskIds.current)
    ) {
      setMaskRemoving(true);
      try {
        await removeMask(attachment.id);
      } catch (error) {
        setMaskFile(file);
        setMaskAttachment(attachment);
        setMaskError(error instanceof Error ? error.message : "Couldn’t remove the mask.");
        setMaskCleanupFailed(true);
      } finally {
        setMaskRemoving(false);
      }
    }
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (
      !prompt.trim() || !model || busy || maskUploading || maskRemoving || Boolean(maskError) ||
      (source && !source.attachmentId)
    ) return;
    const input = { prompt: prompt.trim(), model, size, count };
    submittedMaskId.current = maskAttachment?.id;
    submit(
      source
        ? {
          ...input,
          sourceAssetId: source.id,
          sourceAttachmentId: source.attachmentId!,
          ...(maskAttachment ? { maskAttachmentId: maskAttachment.id } : {}),
        }
        : input,
    );
  };
  return (
    <Modal
      title={source ? "Edit image" : "Create images"}
      close={closeSheet}
      dismissible={!busy && !maskRemoving}
      variant="wide"
    >
      {preview
        ? (
          <ImageLightbox
            embedded
            assets={state.assets}
            activeId={preview}
            close={closePreview}
            select={setPreview}
            edit={edit}
          />
        )
        : (
          <form className="image-generation-sheet" onSubmit={send}>
            {source?.contentUrl && (
              <div className="image-source">
                <img src={source.thumbnailUrl ?? source.contentUrl} alt="Image to edit" />
                <span>
                  <strong>Editing this version</strong>
                  <small>
                    Original remains unchanged. The result becomes a new immutable version.
                  </small>
                </span>
              </div>
            )}
            {source && uploadMask && (
              <fieldset className="image-mask-field">
                <legend>
                  Mask <span>Optional PNG</span>
                </legend>
                <input
                  ref={maskInput}
                  hidden
                  type="file"
                  accept="image/png,.png"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) beginMaskUpload(file);
                    event.target.value = "";
                  }}
                />
                {maskFile
                  ? (
                    <div className="image-mask-row" aria-live="polite">
                      {maskPreview
                        ? <img src={maskPreview} alt="Mask preview" />
                        : <ImageIcon aria-hidden="true" />}
                      <span>
                        <strong>{maskFile.name}</strong>
                        <small>
                          {maskUploading
                            ? `Uploading ${maskProgress}%`
                            : maskRemoving
                            ? "Removing…"
                            : replacementFailed
                            ? "Previous mask retained · choose Use previous or Replace"
                            : maskAttachment
                            ? "Ready · transparent areas will be edited"
                            : "Upload failed"}
                        </small>
                        {maskUploading && <progress max="100" value={maskProgress} />}
                      </span>
                      {!maskAttachment && !maskUploading && (
                        <button
                          type="button"
                          onClick={() => beginMaskUpload(maskFile)}
                        >
                          <RefreshCw size={15} /> Retry
                        </button>
                      )}
                      {maskAttachment && !maskUploading && (
                        <>
                          {replacementFailed && (
                            <button
                              type="button"
                              disabled={busy || maskRemoving}
                              onClick={() => {
                                setReplacementFailed(false);
                                setMaskError("");
                              }}
                            >
                              Use previous
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy || maskRemoving}
                            onClick={() => maskInput.current?.click()}
                          >
                            <Upload size={15} /> Replace
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        aria-label="Remove mask"
                        disabled={busy || maskRemoving}
                        onClick={() => void clearMask()}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )
                  : (
                    <button
                      type="button"
                      className="image-mask-picker"
                      onClick={() => maskInput.current?.click()}
                    >
                      <Upload size={17} /> Add a mask
                    </button>
                  )}
                {maskError && <p className="form-error" role="alert">{maskError}</p>}
              </fieldset>
            )}
            <label>
              <span>{source ? "Describe your changes" : "Describe the image"}</span>
              <textarea
                data-autofocus
                rows={4}
                maxLength={4000}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                required
              />
            </label>
            <div className="image-generation-options">
              <label>
                <span>Model</span>
                <select value={model} onChange={(event) => setModel(event.target.value)} required>
                  {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>
                <span>Size</span>
                <select value={size} onChange={(event) => setSize(event.target.value)}>
                  <option>1024x1024</option>
                  <option>1536x1024</option>
                  <option>1024x1536</option>
                </select>
              </label>
              {!source && (
                <label>
                  <span>Images</span>
                  <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                    {[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}
                  </select>
                </label>
              )}
            </div>
            {busy && (
              <p role="status" aria-live="polite">
                <ImageIcon aria-hidden="true" /> Creating durable image assets…
              </p>
            )}
            {state.phase === "error" && <p className="form-error" role="alert">{state.error}</p>}
            {state.phase === "cancelled" && <p role="status">Image generation cancelled.</p>}
            {source && state.phase === "success" && state.assets.length > 0 && (
              <p className="image-edit-success" role="status">
                New immutable version created. The source and mask remain unchanged.
              </p>
            )}
            {state.assets.length > 0 && (
              <ImageResultGrid
                assets={state.assets}
                selectedIds={selectedIds}
                onOpen={(asset) => setPreview(asset.id)}
                onAdd={add}
                onEdit={edit}
              />
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={maskRemoving}
                onClick={busy ? cancel : maskCleanupFailed ? close : () => void closeSheet()}
              >
                {busy
                  ? (
                    <>
                      <Square size={14} /> Cancel generation
                    </>
                  )
                  : maskRemoving
                  ? "Cleaning up…"
                  : maskCleanupFailed
                  ? "Close anyway"
                  : "Close"}
              </button>
              <button
                className="primary"
                disabled={busy || maskUploading || maskRemoving || Boolean(maskError) ||
                  !prompt.trim() || !model ||
                  (Boolean(source) && !source?.attachmentId)}
              >
                {busy ? "Creating…" : source ? "Create edit" : "Create"}
              </button>
            </div>
          </form>
        )}
    </Modal>
  );
}
