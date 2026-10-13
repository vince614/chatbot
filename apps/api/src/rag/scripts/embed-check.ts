// npm run rag:embed-check — vérifie la config Voyage sur trois phrases d'exemple.
// Aucun accès à la base ; consomme quelques dizaines de tokens.
import { ConfigError } from "../../config.js";
import { loadEmbeddingConfig } from "../config.js";
import { createEmbeddingClient } from "../embeddings/index.js";

const PASSAGES = [
  "Les frais de connexion internet sont remboursés à hauteur de 30 euros par mois en télétravail.",
  "La mutuelle d'entreprise couvre le conjoint et les enfants à charge.",
  "Le VPN est obligatoire pour accéder au réseau interne depuis l'extérieur.",
];
const QUESTION = "Combien est-ce qu'on me rembourse pour ma box quand je bosse de chez moi ?";

async function main(): Promise<void> {
  const config = loadEmbeddingConfig();
  const client = createEmbeddingClient(config);
  console.log(`Fournisseur : ${config.provider} · modèle : ${config.model} · dimension : ${client.dimension}`);

  const { vectors, totalTokens } = await client.embedDocuments(PASSAGES);
  const query = await client.embedQuery(QUESTION);
  console.log(`${vectors.length} passages vectorisés (${totalTokens} tokens facturés), 1 question.`);
  console.log(`Norme du vecteur question : ${norm(query).toFixed(4)} (≈ 1 : vecteurs normalisés)\n`);

  console.log(`Question : « ${QUESTION} »`);
  PASSAGES.map((passage, i) => ({ passage, score: cosine(query, vectors[i]!) }))
    .sort((a, b) => b.score - a.score)
    .forEach(({ passage, score }) => console.log(`  ${score.toFixed(3)}  ${passage}`));
}

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i]!, 0);
  return dot / (norm(a) * norm(b));
}

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
