import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { type EvalQuestion, questionSchema, QUESTIONS_FILE, type RunFile, RUNS_DIR } from "./types.js";

/** « 2026-10-15T11-00-00 », ou le chemin de n'importe quel fichier du run (.json, .md, .notes.json, .scores.json, .judge.json). */
export function runIdFromArg(arg: string): string {
  return path.basename(arg).replace(/(\.notes|\.scores|\.judge)?\.(json|md)$/, "");
}

export async function loadRun(arg: string): Promise<{ id: string; run: RunFile }> {
  const id = runIdFromArg(arg);
  return { id, run: JSON.parse(await readFile(`${RUNS_DIR}${id}.json`, "utf8")) as RunFile };
}

export async function loadQuestions(): Promise<EvalQuestion[]> {
  return z.array(questionSchema).parse(JSON.parse(await readFile(QUESTIONS_FILE, "utf8")));
}
