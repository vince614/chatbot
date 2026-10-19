// Attaque 3 - Consommation sans limite (OWASP LLM10).
//
// Objectif : MESURER, pas inonder. Quelques requetes, charges minimales, pour
// montrer que /api/chat n'a aucune limite de debit ni budget par utilisateur,
// et chiffrer l'amplification (petite entree -> gros travail cote serveur).
//
// Volets :
//   A. Bornes statiques : ce qui est REFUSE (451 messages, message trop long)
//      et ce qui est ACCEPTE (50 messages, message de 8000 car.). Prouve que
//      les seules barrieres sont des plafonds fixes de schema, rien de dynamique.
//   B. Absence de rate limit : une rafale de requetes concurrentes du MEME
//      utilisateur. Aucune n'est rejetee (pas de 429), toutes sont traitees.
//   C. Amplification : une petite question -> combien d'appels modele / outils.
//
// Usage : API_BASE=http://127.0.0.1:3000 node security/attacks/03-consommation/attack.mjs
import { chat } from "../lib/sse-client.mjs";

const BASE = process.env.API_BASE ?? "http://127.0.0.1:3000";
const USER = process.env.ATTACK_USER ?? "bruno";
const BURST = Number(process.env.BURST ?? 6); // volontairement modeste

// POST brut : renvoie le statut HTTP (pour voir les 400/429), sans parser le SSE.
async function rawPost(body) {
  const started = performance.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": USER },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // On ne consomme pas le flux : on coupe tout de suite si c'etait un 200 SSE.
  return { status: res.status, ms: Math.round(performance.now() - started), snippet: text.slice(0, 160) };
}

async function voletA() {
  console.log("\n=== A. Bornes statiques (le seul garde-fou) ===");
  const tooMany = Array.from({ length: 51 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "ok" }));
  // 51 messages se termine par un message "user" (index 50 pair) : seul le nombre doit faire echouer.
  const r1 = await rawPost({ messages: tooMany });
  console.log(`51 messages                 -> HTTP ${r1.status} ${r1.status === 400 ? "(refuse: > 50)" : ""} ${r1.snippet}`);

  const tooLong = [{ role: "user", content: "a".repeat(8001) }];
  const r2 = await rawPost({ messages: tooLong });
  console.log(`1 message de 8001 caracteres -> HTTP ${r2.status} ${r2.status === 400 ? "(refuse: > 8000)" : ""} ${r2.snippet}`);

  // Accepte : juste sous les plafonds. Ces deux-la appellent vraiment le modele.
  const atMsgCap = Array.from({ length: 50 }, (_, i) =>
    i === 49 ? { role: "user", content: "Reponds uniquement par: OK" } : { role: i % 2 ? "assistant" : "user", content: "ok" },
  );
  const r3 = await chatTimed({ messages: atMsgCap });
  console.log(`50 messages (plafond)        -> HTTP 200, ${r3.ms} ms, reponse ${r3.len} car. (ACCEPTE)`);

  const atLenCap = [{ role: "user", content: "Voici un long texte. " + "lorem ipsum ".repeat(600) + " Reponds uniquement par: OK" }];
  const r4 = await chatTimed({ messages: atLenCap });
  console.log(`1 message ~8000 car.         -> HTTP 200, ${r4.ms} ms, reponse ${r4.len} car. (ACCEPTE, aucun budget par utilisateur)`);
}

async function chatTimed(body) {
  const started = performance.now();
  const res = await chat({ userId: USER, messages: body.messages });
  return { ms: Math.round(performance.now() - started), len: res.text.length, toolCalls: res.toolCalls, errors: res.errors };
}

async function voletB() {
  console.log(`\n=== B. Absence de rate limit : ${BURST} requetes concurrentes du meme utilisateur ===`);
  const q = { messages: [{ role: "user", content: "Reponds uniquement par: OK" }] };
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: BURST }, async (_, i) => {
      const t0 = performance.now();
      try {
        const res = await chat({ userId: USER, messages: q.messages });
        return { i, ok: res.errors.length === 0, ms: Math.round(performance.now() - t0), err: res.errors[0] };
      } catch (e) {
        return { i, ok: false, ms: Math.round(performance.now() - t0), err: e.message };
      }
    }),
  );
  const wall = Math.round(performance.now() - started);
  const okCount = results.filter((r) => r.ok).length;
  const rejected = results.filter((r) => /429|too many|rate/i.test(r.err ?? "")).length;
  for (const r of results) console.log(`  req#${r.i} ${r.ok ? "OK" : "ERR"} ${r.ms} ms ${r.err ? "(" + r.err + ")" : ""}`);
  console.log(`Total : ${okCount}/${BURST} traitees en ${wall} ms de mur. Rejets pour debit (429) : ${rejected}.`);
  console.log(
    `Les ${BURST} ont ete lancees d'un coup, du meme utilisateur : aucune file, aucun plafond de concurrence, aucun 429.`,
  );
}

async function voletC() {
  console.log("\n=== C. Amplification : petite entree -> travail serveur ===");
  const q = "Donne-moi l'acces au Discord tech, la liste des salons, et la duree des invitations.";
  const r = await chatTimed({ messages: [{ role: "user", content: q }] });
  console.log(`Entree : "${q}" (${q.length} caracteres)`);
  console.log(`Sortie : ${r.len} car. en ${r.ms} ms. Appels d'outils (recherche + embeddings) : ${r.toolCalls.length}.`);
  console.log(`Chaque appel d'outil declenche un embedding Voyage + une requete vectorielle, puis un nouvel appel modele.`);
  console.log(`Plafond cote code : jusqu'a 5 tours d'outils (MAX_TOOL_TURNS) et 16000 tokens de sortie par requete.`);
}

async function main() {
  console.log(`Cible ${BASE} — utilisateur ${USER}`);
  await voletA();
  await voletB();
  await voletC();
  console.log("\nRappel : test volontairement modeste (quelques requetes). Aucune limite cote serveur ne s'est opposee a nous.");
}

main().catch((e) => {
  console.error("Echec (raison technique ?) :", e.message);
  process.exitCode = 1;
});
