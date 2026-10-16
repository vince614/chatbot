import type { UiMessage } from "../chat/types";
import { saveConversation } from "./conversations";
import type { Conversation } from "./types";

/** Ce qu'il faut écrire : une conversation et ses messages, figés au moment de la demande. */
export interface Snapshot {
  conversation: Conversation;
  messages: readonly UiMessage[];
}

export interface Autosave {
  /** Demande une sauvegarde différée : au plus une écriture par délai, avec le dernier état demandé. */
  schedule(snapshot: Snapshot): void;
  /** Écrit tout de suite ce qui attend (fin de réponse, Stop, erreur, changement de conversation). */
  flush(): Promise<void>;
  /** Oublie ce qui attend, puis attend la fin de l'écriture en cours (suppression, « Tout effacer »). */
  discard(): Promise<void>;
}

export interface AutosaveOptions {
  delayMs: number;
  /** Prévenu après chaque écriture réussie, avec ce qui a été écrit (le titre a pu changer). */
  onSaved: (saved: Conversation, durationMs: number) => void;
  onError: (error: unknown) => void;
}

/**
 * La sauvegarde différée de la conversation courante.
 *
 * Pendant le streaming, chaque delta change la réponse : chiffrer et écrire à
 * chaque fois (des dizaines de fois par seconde) serait inutile. La première
 * demande arme un minuteur ; les suivantes remplacent seulement l'état à
 * écrire. Au bout du délai, UNE écriture avec le dernier état.
 *
 * Les écritures sont enchaînées : une écriture lente ne peut pas se terminer
 * après une plus récente et la remplacer par un état plus ancien.
 *
 * LIMITE (deux onglets) : chaque onglet écrit sa version entière de la
 * conversation, et la dernière écriture gagne. Si deux onglets ont la même
 * conversation ouverte et y écrivent tous les deux, les messages d'un onglet
 * disparaissent au profit de l'autre. Pour mieux faire : un numéro de
 * révision dans la conversation, vérifié dans la transaction d'écriture
 * (refuser d'écraser une révision plus récente), et BroadcastChannel pour
 * prévenir les autres onglets de recharger (voir le cours).
 */
export function createAutosave({ delayMs, onSaved, onError }: AutosaveOptions): Autosave {
  let pending: Snapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  // Augmente à chaque discard : une écriture lancée avant ne doit plus rien remettre en attente.
  let generation = 0;

  function writeNow(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const snapshot = pending;
    pending = null;
    if (!snapshot) return chain;
    const startedIn = generation;
    chain = chain.then(async () => {
      const startedAt = performance.now();
      try {
        const saved = await saveConversation(snapshot.conversation, snapshot.messages);
        onSaved(saved, Math.round(performance.now() - startedAt));
      } catch (error) {
        // On garde cet état pour la prochaine sauvegarde, sauf si un plus récent attend déjà.
        if (generation === startedIn) pending ??= snapshot;
        onError(error);
      }
    });
    return chain;
  }

  return {
    schedule(snapshot) {
      pending = snapshot;
      timer ??= setTimeout(() => void writeNow(), delayMs);
    },
    flush: writeNow,
    async discard() {
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      await chain;
    },
  };
}
