// La couche LLM, version LangChain. ChatAnthropic remplace notre client fait
// main (jour 1) : traduction des messages, streaming, reconstitution des
// appels d'outils sont désormais faits par @langchain/anthropic. Le reste de
// l'application n'importe que ce fichier.
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

/** Un message de la conversation tel que l'application le manipule : du texte. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Niveau d'effort du modèle (profondeur de réflexion). Le modèle actuel n'accepte
 * pas de température : l'effort est le seul réglage, et l'épingler rend les
 * réponses plus stables d'une exécution à l'autre.
 */
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Options nécessaires pour instancier un modèle, quel que soit le fournisseur. */
export interface LlmClientOptions {
  provider: string;
  apiKey: string;
  model: string;
}

export interface ModelSettings {
  /** Effort imposé (l'évaluation l'épingle) ; sinon celui du fournisseur. */
  effort?: LlmEffort;
  /**
   * Température, transmise seulement si elle est fournie : les modèles Claude
   * récents (5.x) la refusent, les 4.5 l'acceptent (le juge de l'évaluation).
   */
  temperature?: number;
}

const KNOWN_PROVIDERS = ["anthropic"] as const;
/** Plafond de tokens générés par réponse ; en streaming, de la marge ne coûte rien. */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Le modèle de chat correspondant à LLM_PROVIDER. Changer de fournisseur, ce
 * serait renvoyer ici un autre BaseChatModel (ChatOpenAI, ChatMistralAI…) :
 * l'agent, les outils et la route ne changent pas.
 */
export function createChatModel({ provider, apiKey, model }: LlmClientOptions, settings: ModelSettings = {}): BaseChatModel {
  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({
        apiKey,
        model,
        maxTokens: MAX_OUTPUT_TOKENS,
        ...(settings.effort && { outputConfig: { effort: settings.effort } }),
        ...(settings.temperature !== undefined && { temperature: settings.temperature }),
      });
    default:
      throw new Error(`Fournisseur LLM inconnu : "${provider}". Valeurs possibles : ${KNOWN_PROVIDERS.join(", ")}.`);
  }
}

/** Nos messages texte vers ceux de LangChain, prompt système en tête. */
export function toLangChainMessages(messages: ChatMessage[], system?: string): BaseMessage[] {
  return [
    ...(system ? [new SystemMessage(system)] : []),
    ...messages.map((message) => (message.role === "user" ? new HumanMessage(message.content) : new AIMessage(message.content))),
  ];
}

/** Un appel simple, sans outils : le texte de la réponse, au fil de l'eau. */
export async function* streamText(
  model: BaseChatModel,
  { system, messages, signal }: { system?: string; messages: ChatMessage[]; signal?: AbortSignal },
): AsyncIterable<string> {
  for await (const chunk of await model.stream(toLangChainMessages(messages, system), { signal })) {
    if (chunk.text) yield chunk.text;
  }
}
