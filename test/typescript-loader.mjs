import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Test-only loading keeps example URLs/CLI paths intact on Node 20 as well as 22/24.
export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".ts")) return nextLoad(url, context);
  const { default: ts } = await import("typescript");
  const source = await readFile(new URL(url), "utf8");
  const result = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new SyntaxError(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
  return { format: "module", source: result.outputText, shortCircuit: true };
}
