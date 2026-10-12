/** Même forme que le type ChatMessage de l'API. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatStatus = "idle" | "streaming" | "error";
