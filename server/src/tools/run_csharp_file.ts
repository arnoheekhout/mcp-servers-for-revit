import { z } from "zod";
import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeCodeInRevit, formatExecutionResult } from "../utils/executeCode.js";

// Directives in the script header, e.g. "// @transaction none" or "// @timeout 900"
function readDirective(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*//\\s*@${name}\\s+(\\S+)`, "m"));
  return match ? match[1] : undefined;
}

export function registerRunCsharpFileTool(server: McpServer) {
  server.tool(
    "run_csharp_file",
    "Run a C# script file in Revit. The file contains the body of `static object Execute(Document document, object[] parameters, UIApplication uiapp)` (same template as send_code_to_revit; local functions are allowed) and must end with a `return`. Header directives: `// @transaction auto|none`, `// @timeout <seconds>`. Relative paths resolve against REVIT_SCRIPTS_DIR (or the server's working directory).",
    {
      file: z.string().describe("Path to the .cs script file"),
      parameters: z
        .array(z.string())
        .optional()
        .describe("Values passed to the script as the `parameters` array"),
      transactionMode: z
        .enum(["auto", "none"])
        .optional()
        .describe("Overrides the // @transaction directive in the file"),
      timeoutSeconds: z
        .number()
        .int()
        .min(5)
        .max(3600)
        .optional()
        .describe("Overrides the // @timeout directive in the file (default 600)"),
    },
    async (args) => {
      try {
        const baseDir = process.env.REVIT_SCRIPTS_DIR || process.cwd();
        const filePath = path.isAbsolute(args.file) ? args.file : path.join(baseDir, args.file);
        if (!fs.existsSync(filePath)) {
          throw new Error(`Script not found: ${filePath}`);
        }
        const source = fs.readFileSync(filePath, "utf8");

        const transactionMode =
          args.transactionMode ??
          (readDirective(source, "transaction") === "none" ? "none" : "auto");
        const timeoutSeconds =
          args.timeoutSeconds ?? parseInt(readDirective(source, "timeout") ?? "600", 10);

        const response = await executeCodeInRevit(
          source,
          args.parameters || [],
          transactionMode,
          timeoutSeconds
        );
        const { ok, text } = formatExecutionResult(response);
        return {
          content: [
            {
              type: "text",
              text: `${ok ? "OK" : "FAILED"} ${path.basename(filePath)} (transaction: ${transactionMode})\n${text}`,
            },
          ],
          isError: !ok,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `run_csharp_file failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
