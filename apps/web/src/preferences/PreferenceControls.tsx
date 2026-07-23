import { RiCheckLine } from "@remixicon/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "../components/ui/field.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import type { UserPreferences } from "../types.ts";
import type { ThemePreference } from "./theme.ts";
import { usePreferenceMutation, usePreferences } from "./usePreferences.ts";

function PreferenceSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = `${label.replaceAll(" ", "-")}-description`;
  return (
    <Field className="setting-row" orientation="horizontal">
      <FieldContent id={descriptionId}>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch
        checked={checked}
        aria-describedby={descriptionId}
        aria-label={label}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </Field>
  );
}

function useSavePreference(preferences?: UserPreferences) {
  const mutation = usePreferenceMutation();
  return {
    busy: mutation.isPending,
    error: mutation.isError ? "Couldn’t save your preference. Try again." : "",
    save: (
      patch: Partial<
        Pick<
          UserPreferences,
          | "theme"
          | "compactConversations"
          | "reduceMotion"
          | "customInstructions"
          | "useMemory"
          | "saveHistory"
          | "preferredModelId"
        >
      >,
    ) => {
      if (preferences) mutation.mutate({ current: preferences, patch });
    },
  };
}

export function AppearancePreferences() {
  const query = usePreferences();
  const { busy, error, save } = useSavePreference(query.data);
  if (query.isLoading) return <p role="status">Loading appearance…</p>;
  if (!query.data) return <p role="alert">Appearance preferences are unavailable.</p>;
  const value = query.data;
  const themes: Array<{ id: ThemePreference; label: string }> = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "system", label: "System" },
  ];
  return (
    <>
      <div className="theme-grid" role="radiogroup" aria-label="Color theme">
        {themes.map((theme) => (
          <Button
            type="button"
            role="radio"
            aria-checked={value.theme === theme.id}
            key={theme.id}
            className={value.theme === theme.id ? "selected" : ""}
            variant="outline"
            disabled={busy}
            onClick={() => save({ theme: theme.id })}
          >
            <div className={`theme-preview ${theme.id}`} aria-hidden="true">
              <span />
              <i />
              <i />
            </div>
            <span>{theme.label}{value.theme === theme.id && <RiCheckLine size={15} />}</span>
          </Button>
        ))}
      </div>
      <PreferenceSwitch
        label="Compact conversations"
        description="Show more conversations in the sidebar"
        checked={value.compactConversations}
        disabled={busy}
        onChange={(checked) => save({ compactConversations: checked })}
      />
      <PreferenceSwitch
        label="Reduce motion"
        description="Minimize non-essential animations"
        checked={value.reduceMotion}
        disabled={busy}
        onChange={(checked) => save({ reduceMotion: checked })}
      />
      {error && <FieldError className="form-error">{error}</FieldError>}
    </>
  );
}

export function PersonalizationPreferences() {
  const query = usePreferences();
  const { busy, error, save } = useSavePreference(query.data);
  const [instructions, setInstructions] = useState("");
  const lastServerInstructions = useRef("");
  useEffect(() => {
    const next = query.data?.customInstructions ?? "";
    setInstructions((current) => current === lastServerInstructions.current ? next : current);
    lastServerInstructions.current = next;
  }, [query.data?.customInstructions]);
  if (query.isLoading) return <p role="status">Loading personalization…</p>;
  if (!query.data) return <p role="alert">Personalization preferences are unavailable.</p>;
  const value = query.data;
  const dirty = instructions !== value.customInstructions;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save({ customInstructions: instructions });
  };
  return (
    <>
      <form onSubmit={submit}>
        <Field className="field">
          <FieldLabel htmlFor="custom-instructions">Custom instructions</FieldLabel>
          <Textarea
            id="custom-instructions"
            rows={7}
            maxLength={20_000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            aria-describedby="custom-instructions-help custom-instructions-count"
          />
        </Field>
        <div className="preference-save-row">
          <small id="custom-instructions-help">
            Applied to new responses in your chats.
          </small>
          <small id="custom-instructions-count">
            {instructions.length.toLocaleString()} / 20,000
          </small>
          <Button type="submit" disabled={!dirty || busy}>
            {busy ? "Saving…" : dirty ? "Save instructions" : "Saved"}
          </Button>
        </div>
      </form>
      <PreferenceSwitch
        label="Save conversation history"
        description="Temporary chats are never included"
        checked={value.saveHistory}
        disabled={busy}
        onChange={(checked) => save({ saveHistory: checked })}
      />
      {error && <FieldError className="form-error">{error}</FieldError>}
    </>
  );
}
