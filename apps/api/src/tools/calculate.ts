import { z } from "zod";

import type { Tool } from "./types.js";

const schema = z.object({
  expression: z
    .string()
    .trim()
    .min(1, "L'expression est vide.")
    .max(500, "L'expression est trop longue.")
    .describe('Expression arithmétique, par exemple "1234 * 5678" ou "(2 + 3) ^ 2 / 7".'),
});

export const calculateTool: Tool<typeof schema> = {
  name: "calculate",
  description:
    "Évalue une expression arithmétique exacte : nombres décimaux, + - * / % ^, " +
    "parenthèses et moins unaire. À utiliser pour tout calcul plutôt que de le faire de tête.",
  schema,
  async execute({ expression }) {
    const result = evaluate(expression);
    return { expression, result };
  },
};

/*
 * Évaluateur par descente récursive, sans eval ni Function.
 *
 *   expression := terme (("+" | "-") terme)*
 *   terme      := unaire (("*" | "/" | "%") unaire)*
 *   unaire     := "-" unaire | puissance          (-3 ^ 2 vaut -9, comme en maths)
 *   puissance  := primaire ("^" unaire)?          (^ est associatif à droite : 2 ^ 3 ^ 2 = 512)
 *   primaire   := nombre | "(" expression ")"
 */
export function evaluate(source: string): number {
  const parser = new Parser(source);
  const value = parser.parseExpression();
  parser.expectEnd();
  if (!Number.isFinite(value)) {
    throw new Error("Le résultat n'est pas un nombre fini (division par zéro ?).");
  }
  return value;
}

class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      if (this.consume("+")) value += this.parseTerm();
      else if (this.consume("-")) value -= this.parseTerm();
      else return value;
    }
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    for (;;) {
      if (this.consume("*")) value *= this.parseUnary();
      else if (this.consume("/")) value = this.divide(value, this.parseUnary());
      else if (this.consume("%")) value = this.modulo(value, this.parseUnary());
      else return value;
    }
  }

  private parseUnary(): number {
    if (this.consume("-")) return -this.parseUnary();
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    if (this.consume("^")) return base ** this.parseUnary();
    return base;
  }

  private parsePrimary(): number {
    if (this.consume("(")) {
      const value = this.parseExpression();
      if (!this.consume(")")) this.fail("parenthèse fermante attendue");
      return value;
    }

    const start = this.position;
    while (/[0-9.]/.test(this.peek())) this.position += 1;
    const text = this.source.slice(start, this.position);
    if (text === "" || text === ".") this.fail("nombre attendu");

    const value = Number(text);
    if (Number.isNaN(value)) this.fail(`nombre invalide "${text}"`);
    return value;
  }

  expectEnd(): void {
    this.skipSpaces();
    if (this.position < this.source.length) {
      this.fail(`caractère inattendu "${this.source[this.position]}"`);
    }
  }

  private divide(a: number, b: number): number {
    if (b === 0) throw new Error("Division par zéro.");
    return a / b;
  }

  private modulo(a: number, b: number): number {
    if (b === 0) throw new Error("Modulo par zéro.");
    return a % b;
  }

  /** Consomme le symbole s'il est le prochain caractère non blanc. */
  private consume(symbol: string): boolean {
    this.skipSpaces();
    if (this.source.startsWith(symbol, this.position)) {
      this.position += symbol.length;
      return true;
    }
    return false;
  }

  private peek(): string {
    return this.source[this.position] ?? "";
  }

  private skipSpaces(): void {
    while (this.peek() === " ") this.position += 1;
  }

  private fail(reason: string): never {
    throw new Error(`Expression invalide à la position ${this.position + 1} : ${reason}.`);
  }
}
