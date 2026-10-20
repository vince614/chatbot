import { fileURLToPath } from "node:url";

import { loadDotEnv } from "@chatbot/rag/env";
import {
  AGENDA_RESOURCE,
  loadClientCredentials,
  loadIssuer,
  loadMcpResource,
  type OAuthClientCredentials,
  parsePort,
  SCOPES,
} from "@chatbot/rag/oauth";
import { loadUsers, type User } from "@chatbot/rag/users";

/**
 * La configuration du serveur d'autorisation. Il lit le .env de l'API (même
 * profondeur depuis src/ et dist/) et son annuaire : c'est lui qui sait
 * quels utilisateurs existent.
 */
const API_DIR = new URL("../../api/", import.meta.url);
const ENV_FILE = fileURLToPath(new URL(".env", API_DIR));
const USERS_FILE = fileURLToPath(new URL("data/users.json", API_DIR));

/** Durée de vie d'un jeton : courte, car un jeton volé sert jusqu'à son expiration. */
const DEFAULT_TOKEN_TTL_S = 300;

/** Un client enregistré : ses identifiants, et ce qu'il a le droit de demander. */
export interface RegisteredClient extends OAuthClientCredentials {
  /** Les ressources (audiences) pour lesquelles il peut obtenir un jeton. */
  resources: readonly string[];
  scopes: readonly string[];
}

export interface AuthServerConfig {
  issuer: string;
  port: number;
  tokenTtlSeconds: number;
  /** Un seul client dans cet exercice : l'API du chatbot. */
  client: RegisteredClient;
  users: ReadonlyMap<string, User>;
}

export async function loadAuthServerConfig(): Promise<AuthServerConfig> {
  loadDotEnv(ENV_FILE);
  const issuer = loadIssuer();
  return {
    issuer,
    // Le port est celui de l'émetteur : un seul réglage, AUTH_ISSUER.
    port: parsePort("AUTH_ISSUER (port)", new URL(issuer).port || "80"),
    tokenTtlSeconds: parsePort("AUTH_TOKEN_TTL_S", process.env["AUTH_TOKEN_TTL_S"]?.trim() || String(DEFAULT_TOKEN_TTL_S)),
    client: {
      ...loadClientCredentials(),
      resources: [loadMcpResource(), AGENDA_RESOURCE],
      scopes: [SCOPES.documents, SCOPES.agenda],
    },
    users: await loadUsers(USERS_FILE),
  };
}
