import { createContext } from "react";

/**
 * Portalled controls are outside a chat session's hidden/inert DOM subtree. Consumers use this
 * signal to retain their state while refusing focus and interaction when their session is hidden.
 */
export const ChatSessionActivityContext = createContext(true);
