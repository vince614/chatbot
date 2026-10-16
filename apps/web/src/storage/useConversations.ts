import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteConversation,
  listConversations,
  loadConversation,
  newConversation,
  UnreadableConversationError,
  wipeAll,
} from "./conversations";
import type { Conversation, ConversationListItem } from "./types";

export type ConversationsStatus = "loading" | "ready" | "unavailable";

export interface UseConversationsResult {
  /** Les conversations de l'utilisateur, puis les illisibles. */
  items: ConversationListItem[];
  /** La conversation ouverte. Neuve (pas encore écrite) tant qu'elle n'a pas de message. null sans utilisateur. */
  current: Conversation | null;
  status: ConversationsStatus;
  /** Dernier problème à afficher (conversation illisible, stockage indisponible), ou null. */
  notice: string | null;
  select: (id: string) => Promise<void>;
  create: () => void;
  remove: (id: string) => Promise<void>;
  wipe: () => Promise<void>;
  /** À appeler après une sauvegarde : met à jour la ligne (titre, date) sans recharger la conversation. */
  onSaved: (saved: Conversation) => void;
}

/**
 * La liste des conversations de l'utilisateur et la conversation ouverte.
 *
 * Au chargement (et à chaque changement d'utilisateur), on ouvre la
 * conversation la plus récemment modifiée, ou une neuve s'il n'y en a pas.
 */
export function useConversations(userId: string): UseConversationsResult {
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [status, setStatus] = useState<ConversationsStatus>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  // L'utilisateur du moment : une lecture lancée pour A et finie après le
  // passage à B ne doit rien afficher chez B.
  const userIdRef = useRef(userId);

  useEffect(() => {
    userIdRef.current = userId;
    // Tout de suite : l'écran ne doit pas montrer la conversation de
    // l'utilisateur précédent pendant que la liste du suivant se déchiffre.
    setCurrent(null);
    setItems([]);
    setNotice(null);
    if (!userId) return;

    // Une réponse arrivée après un nouveau changement d'utilisateur est ignorée.
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const list = await listConversations(userId);
        if (cancelled) return;
        setItems(list);
        const latest = list.find((item) => !item.illisible);
        const opened = latest ? await loadConversation(latest.id) : undefined;
        if (cancelled) return;
        setCurrent(opened ?? newConversation(userId));
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        // Stockage indisponible : le chat marche quand même, sans mémoire.
        setCurrent(newConversation(userId));
        setStatus("unavailable");
        setNotice(`Historique indisponible : ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const list = await listConversations(userId);
    if (userIdRef.current === userId) setItems(list);
  }, [userId]);

  const select = useCallback(
    async (id: string) => {
      if (id === current?.id) return;
      try {
        const conversation = await loadConversation(id);
        if (userIdRef.current !== userId) return;
        if (!conversation) {
          setNotice("Cette conversation n'existe plus.");
          await refresh();
          return;
        }
        // Garde-fou : jamais la conversation d'un autre utilisateur.
        if (conversation.userId !== userId) return;
        setCurrent(conversation);
        setNotice(null);
      } catch (error) {
        if (userIdRef.current !== userId) return;
        setNotice(
          error instanceof UnreadableConversationError
            ? "Conversation illisible (données corrompues ou clé perdue) : elle ne peut qu'être supprimée."
            : `Lecture impossible : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [current?.id, refresh, userId],
  );

  const create = useCallback(() => {
    if (!userId) return;
    setCurrent(newConversation(userId));
    setNotice(null);
  }, [userId]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id);
        if (id === current?.id) setCurrent(newConversation(userId));
        await refresh();
      } catch (error) {
        setNotice(`Suppression impossible : ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [current?.id, userId, refresh],
  );

  const wipe = useCallback(async () => {
    try {
      await wipeAll();
      setItems([]);
      setCurrent(userId ? newConversation(userId) : null);
      setNotice(null);
    } catch (error) {
      setNotice(`Effacement impossible : ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [userId]);

  const onSaved = useCallback(
    (saved: Conversation) => {
      // Une sauvegarde peut finir après un changement d'utilisateur : elle ne
      // doit pas faire apparaître sa conversation dans la liste du suivant.
      if (saved.userId !== userId) return;
      setItems((prev) => {
        const line: ConversationListItem = {
          id: saved.id,
          illisible: false,
          userId: saved.userId,
          titre: saved.titre,
          creeLe: saved.creeLe,
          modifieLe: saved.modifieLe,
        };
        const others = prev.filter((item) => item.id !== saved.id);
        // Elle vient d'être modifiée : en tête, devant les autres lisibles.
        return [line, ...others];
      });
    },
    [userId],
  );

  return { items, current, status, notice, select, create, remove, wipe, onSaved };
}
