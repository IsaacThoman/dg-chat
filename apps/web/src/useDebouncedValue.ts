import { useEffect, useState } from "react";

/** Keeps text inputs responsive while preventing a request for every keystroke. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(value), delayMs);
    return () => globalThis.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}
