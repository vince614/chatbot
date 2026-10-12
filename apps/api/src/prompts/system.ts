/**
 * Prompt système, défini côté serveur uniquement. Le client ne peut ni le
 * lire ni le remplacer : il n'envoie que des messages user/assistant.
 */
export const SYSTEM_PROMPT = [
  "Tu es un assistant de conversation concis et précis.",
  "Réponds dans la langue de l'utilisateur.",
  "Utilise le Markdown (listes, blocs de code) quand cela clarifie la réponse.",
].join(" ");
