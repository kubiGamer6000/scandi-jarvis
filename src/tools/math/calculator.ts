import { tool } from "langchain";
import { z } from "zod";

/**
 * Safe arithmetic evaluator. The model regularly needs to crunch numbers for
 * margins, conversion rates, ad spend, etc., and is much more reliable when it
 * delegates the actual math to a real calculator.
 *
 * We intentionally do NOT eval() user/model input. Instead we tokenise and
 * evaluate a tiny grammar that supports +, -, *, /, %, **, parentheses, and
 * a small set of named functions / constants.
 */
const ALLOWED_FUNCS: Record<string, (n: number) => number> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  ln: Math.log,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

const ALLOWED_CONSTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

type Token =
  | { type: "num"; value: number }
  | { type: "op"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "comma" }
  | { type: "ident"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9._]/.test(input[j]!)) j++;
      // optional scientific notation
      if (j < input.length && /[eE]/.test(input[j]!)) {
        j++;
        if (j < input.length && /[+-]/.test(input[j]!)) j++;
        while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      }
      const raw = input.slice(i, j).replace(/_/g, "");
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new Error(`Bad number: "${raw}"`);
      tokens.push({ type: "num", value: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j]!)) j++;
      tokens.push({ type: "ident", value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      i++;
      continue;
    }
    if (ch === "*" && input[i + 1] === "*") {
      tokens.push({ type: "op", value: "**" });
      i += 2;
      continue;
    }
    if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "op", value: ch === "^" ? "**" : ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }
  return tokens;
}

// Recursive-descent parser implementing standard precedence:
//   expr   = term (("+"|"-") term)*
//   term   = power (("*"|"/"|"%") power)*
//   power  = unary ("**" power)?           (right-assoc)
//   unary  = ("+"|"-")? atom
//   atom   = number | ident | ident "(" expr ")" | "(" expr ")"
class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): number {
    const v = this.expr();
    if (this.pos !== this.tokens.length) {
      throw new Error("Trailing tokens after expression");
    }
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private consume(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error("Unexpected end of expression");
    this.pos++;
    return t;
  }

  private expr(): number {
    let v = this.term();
    while (true) {
      const t = this.peek();
      if (t?.type === "op" && (t.value === "+" || t.value === "-")) {
        this.consume();
        const rhs = this.term();
        v = t.value === "+" ? v + rhs : v - rhs;
      } else {
        return v;
      }
    }
  }

  private term(): number {
    let v = this.power();
    while (true) {
      const t = this.peek();
      if (
        t?.type === "op" &&
        (t.value === "*" || t.value === "/" || t.value === "%")
      ) {
        this.consume();
        const rhs = this.power();
        v = t.value === "*" ? v * rhs : t.value === "/" ? v / rhs : v % rhs;
      } else {
        return v;
      }
    }
  }

  private power(): number {
    const base = this.unary();
    const t = this.peek();
    if (t?.type === "op" && t.value === "**") {
      this.consume();
      return base ** this.power();
    }
    return base;
  }

  private unary(): number {
    const t = this.peek();
    if (t?.type === "op" && (t.value === "+" || t.value === "-")) {
      this.consume();
      const v = this.unary();
      return t.value === "-" ? -v : v;
    }
    return this.atom();
  }

  private atom(): number {
    const t = this.consume();
    if (t.type === "num") return t.value;
    if (t.type === "lparen") {
      const v = this.expr();
      const close = this.consume();
      if (close.type !== "rparen") throw new Error('Expected ")"');
      return v;
    }
    if (t.type === "ident") {
      const next = this.peek();
      if (next?.type === "lparen") {
        this.consume();
        const arg = this.expr();
        const close = this.consume();
        if (close.type !== "rparen") throw new Error('Expected ")"');
        const fn = ALLOWED_FUNCS[t.value];
        if (!fn) throw new Error(`Unknown function "${t.value}"`);
        return fn(arg);
      }
      const c = ALLOWED_CONSTS[t.value];
      if (c === undefined) throw new Error(`Unknown identifier "${t.value}"`);
      return c;
    }
    throw new Error(`Unexpected token "${JSON.stringify(t)}"`);
  }
}

export const calculator = tool(
  ({ expression }: { expression: string }) => {
    try {
      const tokens = tokenize(expression);
      const result = new Parser(tokens).parse();
      if (!Number.isFinite(result)) {
        return JSON.stringify({ ok: false, error: "Result is not finite" });
      }
      return JSON.stringify({ ok: true, expression, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ ok: false, expression, error: message });
    }
  },
  {
    name: "calculator",
    description:
      "Evaluate a math expression and return the numeric result. Use this for any non-trivial arithmetic instead of doing it in your head. " +
      "Supported: +, -, *, /, %, ** (or ^), parentheses, scientific notation, and functions abs, sqrt, log, log10, log2, ln, exp, floor, ceil, round, sin, cos, tan, plus the constants pi and e.",
    schema: z.object({
      expression: z
        .string()
        .min(1)
        .describe(
          "The math expression, e.g. '(120 - 95) / 95 * 100' or 'sqrt(2) * pi'",
        ),
    }),
  },
);
