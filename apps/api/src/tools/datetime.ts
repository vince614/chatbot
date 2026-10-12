import { z } from "zod";

import type { Tool } from "./types.js";

const schema = z.object({
  timezone: z
    .string()
    .optional()
    .describe('Fuseau horaire IANA, par exemple "Europe/Paris". Par défaut : UTC.'),
});

export const getCurrentDatetimeTool: Tool<typeof schema> = {
  name: "get_current_datetime",
  description:
    "Donne la date et l'heure actuelles. À utiliser pour toute question qui dépend " +
    "d'aujourd'hui (quel jour sommes-nous, dans combien de jours, quelle heure est-il…) " +
    "plutôt que de deviner.",
  schema,
  async execute({ timezone = "UTC" }) {
    // Intl rejette les fuseaux inconnus : l'erreur remonte au modèle comme résultat d'outil.
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("fr-FR", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      });
    } catch {
      throw new Error(`Fuseau horaire inconnu : "${timezone}".`);
    }

    const now = new Date();
    return {
      iso: now.toISOString(),
      formatted: formatter.format(now),
      weekday: new Intl.DateTimeFormat("fr-FR", { timeZone: timezone, weekday: "long" }).format(now),
      timezone: formatter.resolvedOptions().timeZone,
      unixSeconds: Math.floor(now.getTime() / 1000),
    };
  },
};
