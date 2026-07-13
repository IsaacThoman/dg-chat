import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, ApiError } from "../api.ts";
import type { UserPreferences } from "../types.ts";
import { applyTheme, watchSystemTheme } from "./theme.ts";

export const preferencesKey = ["preferences"] as const;

export function usePreferences() {
  return useQuery({ queryKey: preferencesKey, queryFn: api.preferences });
}

export function usePreferenceMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ current, patch }: {
      current: UserPreferences;
      patch: Parameters<typeof api.updatePreferences>[1];
    }) => api.updatePreferences(current, patch),
    onSuccess: (next) => client.setQueryData(preferencesKey, next),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void client.invalidateQueries({ queryKey: preferencesKey });
      }
    },
  });
}

export function useAppliedPreferences(preferences?: UserPreferences) {
  useEffect(() => {
    if (!preferences) return;
    const root = document.documentElement;
    try {
      localStorage.setItem("dg-chat.theme", preferences.theme);
    } catch {
      // The server remains authoritative when browser storage is unavailable.
    }
    const render = (systemDark?: boolean) => applyTheme(preferences.theme, root, systemDark);
    render();
    root.dataset.compactConversations = String(preferences.compactConversations);
    root.dataset.reduceMotion = String(preferences.reduceMotion);
    return watchSystemTheme(preferences.theme, (systemDark) => render(systemDark));
  }, [preferences]);
}
