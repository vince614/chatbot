/**
 * Les logs du serveur MCP. En transport stdio, stdout EST le canal du
 * protocole : chaque ligne qu'on y écrit doit être un message JSON-RPC. Un
 * simple console.log("démarré") serait lu par le client comme un message
 * invalide. Tout ce qui est destiné à un humain va donc sur stderr, que le
 * client affiche ou enregistre sans l'interpréter.
 */

export function log(message: string): void {
  console.error(`[mcp] ${message}`);
}

/**
 * Filet de sécurité : un console.log oublié, ici ou dans une dépendance,
 * part sur stderr au lieu de corrompre le protocole. Le transport stdio du
 * SDK écrit avec process.stdout.write : il n'est pas concerné.
 */
export function redirectConsoleToStderr(): void {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
}
