// npm run rag:sample-pdf — génère data/pdfs/reglement-interieur.pdf, un document
// de test fictif. Chaque fait est unique et situé sur une page précise, une
// procédure est assez longue pour s'étendre sur deux chunks, et plusieurs
// personnes ont un « adjoint » : de quoi vérifier citations, pages et
// questions de suivi.
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";

import { PDF_DIR } from "../../config.js";

const FILE_NAME = "reglement-interieur.pdf";

type Block = { kind: "title" | "heading" | "paragraph" | "bullet"; text: string };

const h = (text: string): Block => ({ kind: "heading", text });
const p = (text: string): Block => ({ kind: "paragraph", text });
const li = (text: string): Block => ({ kind: "bullet", text });

const CONTENT: Block[] = [
  { kind: "title", text: "Règlement intérieur de Lumen SAS" },
  h("Article 1 — Objet et champ d'application"),
  p(
    "Le présent règlement intérieur s'applique à l'ensemble des salariés de Lumen SAS, quel que soit leur contrat, " +
      "ainsi qu'aux stagiaires et aux intérimaires présents dans les locaux de Lyon et de Nantes. Il est entré en " +
      "vigueur le 1er mars 2026, après consultation du comité social et économique. Il est affiché dans chaque " +
      "établissement et consultable à tout moment sur l'intranet, rubrique « Vie de l'entreprise ».",
  ),
  p(
    "Les notes de service qui précisent ce règlement ont la même valeur que lui dès leur publication sur l'intranet. " +
      "En cas de contradiction entre une note de service et le présent règlement, le règlement prévaut.",
  ),
  h("Article 2 — Horaires et temps de travail"),
  p(
    "La durée hebdomadaire de travail est de 37 heures, réparties du lundi au vendredi. Les horaires sont variables " +
      "autour de deux plages fixes pendant lesquelles la présence est obligatoire : de 9 h 30 à 12 h et de 14 h à " +
      "16 h 30. L'arrivée est possible à partir de 7 h 30 et le départ jusqu'à 19 h 30.",
  ),
  p(
    "Le temps de travail est enregistré par badge à l'entrée du bâtiment. Un oubli de badge doit être régularisé dans " +
      "le portail MonRH avant la fin de la semaine concernée. La pause déjeuner dure au minimum 45 minutes et au " +
      "maximum deux heures.",
  ),
  p(
    "Les heures supplémentaires ne sont accomplies qu'à la demande écrite du responsable hiérarchique. Elles sont " +
      "récupérées dans les deux mois, ou payées avec une majoration de 25 % si la récupération est impossible.",
  ),
  h("Article 3 — Télétravail"),
  p(
    "Tout salarié ayant terminé sa période d'essai peut télétravailler jusqu'à deux jours par semaine, à l'exception " +
      "du mardi, réservé aux réunions d'équipe sur site. Les jours de télétravail sont choisis avec le responsable " +
      "hiérarchique et peuvent varier d'une semaine à l'autre.",
  ),
  p(
    "La demande initiale se fait dans le portail MonRH au moins dix jours avant le premier jour de télétravail. Le " +
      "responsable dispose de cinq jours ouvrés pour répondre ; un refus doit être motivé par écrit.",
  ),
  p(
    "Une indemnité forfaitaire de 2,50 euros est versée par jour télétravaillé, dans la limite de 50 euros par mois. " +
      "Elle couvre les frais de connexion internet, d'électricité et de chauffage. Elle apparaît sur le bulletin de " +
      "paie du mois suivant.",
  ),
  p(
    "La référente télétravail est Claire Martin, du service des ressources humaines. Son adjoint est Paul Leroy, qui " +
      "la remplace pendant ses absences. Toute question sur l'organisation du télétravail leur est adressée à " +
      "l'adresse teletravail@lumen.example.",
  ),
  h("Article 4 — Congés et absences"),
  p(
    "Chaque salarié à temps plein acquiert 25 jours ouvrés de congés payés par an, auxquels s'ajoutent 10 jours de " +
      "réduction du temps de travail (RTT). Les jours de RTT doivent être posés avant le 31 décembre ; ils ne sont " +
      "ni reportables ni payables.",
  ),
  p(
    "Une absence de plus de cinq jours consécutifs doit être demandée au moins un mois à l'avance. Les congés d'été " +
      "sont demandés avant le 31 mars et validés avant le 15 avril. Au moins deux semaines consécutives sont posées " +
      "entre le 1er mai et le 31 octobre.",
  ),
  p(
    "Des congés exceptionnels sont accordés sans perte de salaire : quatre jours pour un mariage ou un PACS, un jour " +
      "pour un déménagement (une fois par an), trois jours pour la naissance ou l'adoption d'un enfant, en plus du " +
      "congé de paternité légal.",
  ),
  p(
    "En cas d'arrêt maladie, le salarié prévient son responsable le jour même et transmet l'arrêt de travail sous " +
      "48 heures. Lumen SAS maintient le salaire à 100 % dès le premier jour d'arrêt, sans délai de carence.",
  ),
  h("Article 5 — Notes de frais"),
  p(
    "Les frais engagés pour une mission sont remboursés sur présentation des justificatifs originaux, transmis dans le " +
      "portail MonRH au plus tard 30 jours après la dépense. Passé ce délai, aucun remboursement n'est possible.",
  ),
  p(
    "Les plafonds sont les suivants : 20 euros par repas, 120 euros par nuit d'hôtel à Paris et 90 euros en province, " +
      "petit-déjeuner compris. Le train est pris en seconde classe, sauf pour un trajet de plus de trois heures, qui " +
      "peut être effectué en première classe. L'avion n'est autorisé qu'avec l'accord préalable de la direction " +
      "financière.",
  ),
  p(
    "Les frais kilométriques d'un véhicule personnel sont remboursés selon le barème fiscal en vigueur, à condition " +
      "que le trajet n'ait pas pu être effectué en transport en commun dans un délai raisonnable.",
  ),
  h("Article 6 — Procédure en cas d'incident de sécurité informatique"),
  p(
    "Un incident de sécurité est tout événement qui menace la confidentialité, l'intégrité ou la disponibilité des " +
      "données de Lumen SAS : courriel d'hameçonnage ouvert, pièce jointe suspecte exécutée, ordinateur perdu ou volé, " +
      "mot de passe divulgué, comportement anormal d'un poste. Tout salarié qui constate ou soupçonne un incident " +
      "applique la procédure suivante, dans l'ordre, sans attendre d'en être certain.",
  ),
  li(
    "Étape 1 — Débrancher immédiatement le câble réseau et désactiver le Wi-Fi du poste concerné, sans l'éteindre : " +
      "l'extinction efface des traces utiles à l'analyse. Laisser les fenêtres ouvertes telles quelles.",
  ),
  li(
    "Étape 2 — Prévenir le support informatique au poste 4242, ou au 04 72 00 42 42 depuis l'extérieur. Le support " +
      "est joignable de 7 h 30 à 20 h ; en dehors de ces horaires, appeler la ligne d'astreinte au 06 12 34 56 78.",
  ),
  li(
    "Étape 3 — Noter l'heure de la découverte, ce qui a été vu à l'écran, les manipulations effectuées et, le cas " +
      "échéant, l'expéditeur et l'objet du courriel suspect. Ne pas transférer le courriel suspect à des collègues.",
  ),
  li(
    "Étape 4 — Changer sans délai, depuis un autre appareil de confiance, le mot de passe de tout compte qui a pu être " +
      "exposé, en commençant par la messagerie et le portail MonRH.",
  ),
  li(
    "Étape 5 — Ne pas tenter de réparer le poste soi-même, ne pas lancer d'outil de nettoyage et ne pas supprimer de " +
      "fichiers : seul le support informatique intervient sur un poste compromis.",
  ),
  li(
    "Étape 6 — Si des données personnelles de clients ont pu être exposées, en informer le délégué à la protection " +
      "des données dans l'heure, à l'adresse dpo@lumen.example : l'entreprise dispose de 72 heures pour notifier la " +
      "CNIL.",
  ),
  li(
    "Étape 7 — Remettre le poste au support informatique contre un récépissé. Un poste de remplacement est fourni " +
      "dans la journée ouvrée qui suit.",
  ),
  li(
    "Étape 8 — Participer, dans les dix jours, au retour d'expérience organisé par le responsable de la sécurité des " +
      "systèmes d'information. Aucun salarié n'est sanctionné pour avoir signalé de bonne foi un incident, même s'il " +
      "en est à l'origine.",
  ),
  p(
    "Le responsable de la sécurité des systèmes d'information est Karim Benali. Son adjointe est Sophie Durand, qui " +
      "assure l'intérim pendant ses congés et coordonne les exercices annuels de simulation d'hameçonnage.",
  ),
  h("Article 7 — Matériel confié"),
  p(
    "L'ordinateur portable, le téléphone et le badge restent la propriété de Lumen SAS. Leur perte ou leur vol est " +
      "déclaré au support informatique sous 48 heures, accompagné d'un récépissé de dépôt de plainte en cas de vol.",
  ),
  p(
    "Le matériel est restitué le dernier jour de présence en cas de départ. L'installation de logiciels non validés " +
      "par le support informatique est interdite ; une liste des logiciels autorisés est publiée sur l'intranet.",
  ),
  h("Article 8 — Santé, sécurité et discipline"),
  p(
    "Chaque établissement dispose de sauveteurs secouristes du travail, dont la liste est affichée à l'accueil. À " +
      "Lyon, la coordinatrice santé et sécurité est Inès Moreau ; son adjoint est Thomas Girard. Un exercice " +
      "d'évacuation est organisé deux fois par an.",
  ),
  p(
    "Les sanctions applicables, par ordre de gravité, sont l'avertissement, la mise à pied disciplinaire de un à cinq " +
      "jours, la mutation, la rétrogradation et le licenciement. Aucune sanction n'est prononcée sans que le salarié " +
      "ait été informé par écrit des griefs retenus contre lui et ait pu s'expliquer lors d'un entretien.",
  ),
];

// --- Mise en page -------------------------------------------------------------

const PAGE = { width: 595, height: 842 };
const MARGIN = { left: 72, right: 72, top: 95, bottom: 85 };
const STYLE = {
  title: { size: 18, lineHeight: 24, before: 0, after: 18 },
  heading: { size: 13.5, lineHeight: 19, before: 18, after: 8 },
  paragraph: { size: 12, lineHeight: 18, before: 0, after: 11 },
  bullet: { size: 12, lineHeight: 18, before: 0, after: 8 },
} as const;
const BULLET_INDENT = 16;

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function layout(blocks: Block[], regular: PDFFont, bold: PDFFont): Line[][] {
  const pages: Line[][] = [[]];
  let y = PAGE.height - MARGIN.top;

  for (const block of blocks) {
    const style = STYLE[block.kind];
    const isBold = block.kind === "title" || block.kind === "heading";
    const font = isBold ? bold : regular;
    const indent = block.kind === "bullet" ? BULLET_INDENT : 0;
    const width = PAGE.width - MARGIN.left - MARGIN.right - indent;
    const wrapped = wrap(block.text, font, style.size, width);

    // Un titre ne reste jamais seul en bas de page.
    const keepWithNext = isBold ? 3 * STYLE.paragraph.lineHeight : 0;
    if (y - style.before - wrapped.length * style.lineHeight - keepWithNext < MARGIN.bottom) {
      pages.push([]);
      y = PAGE.height - MARGIN.top;
    } else {
      y -= style.before;
    }

    wrapped.forEach((text, i) => {
      if (y - style.lineHeight < MARGIN.bottom) {
        pages.push([]);
        y = PAGE.height - MARGIN.top;
      }
      const prefix = block.kind === "bullet" && i === 0 ? "• " : "";
      const x = MARGIN.left + indent - (prefix ? BULLET_INDENT : 0);
      pages.at(-1)!.push({ text: prefix + text, x, y, size: style.size, bold: isBold });
      y -= style.lineHeight;
    });
    y -= style.after;
  }
  return pages;
}

async function main(): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Règlement intérieur de Lumen SAS (document fictif de test)");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = layout(CONTENT, regular, bold);
  pages.forEach((lines, i) => {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    // En-tête et pied de page répétés : le nettoyage doit les retirer.
    page.drawText("Lumen SAS — Règlement intérieur 2026", { x: MARGIN.left, y: PAGE.height - 50, size: 9, font: regular });
    page.drawText(`Page ${i + 1} sur ${pages.length}`, { x: PAGE.width / 2 - 28, y: 40, size: 9, font: regular });
    for (const line of lines) {
      page.drawText(line.text, { x: line.x, y: line.y, size: line.size, font: line.bold ? bold : regular });
    }
  });

  const target = path.join(PDF_DIR, FILE_NAME);
  await writeFile(target, await pdf.save());
  console.log(`${target} : ${pages.length} pages.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
