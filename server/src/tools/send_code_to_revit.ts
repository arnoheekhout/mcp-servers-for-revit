import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const transactionModeSchema = z
  .enum(["auto", "none"])
  .default("auto")
  .describe(
    "How the snippet should interact with Revit transactions. Use 'auto' to wrap the snippet in a transaction, or 'none' when the called code manages its own transactions."
  );

export function registerSendCodeToRevitTool(server: McpServer) {
  server.tool(
    "send_code_to_revit",
    "Send C# code to Revit for execution. The code is inserted into the body of `static object Execute(Document document, object[] parameters, UIApplication uiapp)`. Available locals: doc, uidoc, app, uiapp, parameters. Usings: System, System.IO, System.Linq, System.Text, System.Collections.Generic, Autodesk.Revit.DB, Autodesk.Revit.DB.Architecture, Autodesk.Revit.DB.Structure, Autodesk.Revit.UI. The code must end with a `return` statement; the returned object is serialized to JSON.",
    {
      code: z
        .string()
        .describe(
          "The C# code to execute in Revit. This code will be inserted into the Execute method of a template with access to Document and parameters."
        ),
      parameters: z
        .array(z.string())
        .optional()
        .describe(
          "Optional execution parameters that will be passed to your code"
        ),
      transactionMode: transactionModeSchema,
      timeoutSeconds: z
        .number()
        .int()
        .min(5)
        .max(3600)
        .default(600)
        .describe(
          "Maximum time to wait for Revit to finish, in seconds. Raise it for exports or heavy modelling."
        ),
    },
    async (args, extra) => {
      const params = {
        code: args.code,
        parameters: args.parameters || [],
        transactionMode: args.transactionMode,
        timeoutSeconds: args.timeoutSeconds,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "send_code_to_revit",
            params,
            (args.timeoutSeconds + 15) * 1000
          );
        });

        return {
          content: [
            {
              type: "text",
              text: `Code execution successful!\nResult: ${JSON.stringify(
                response,
                null,
                2
              )}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Code execution failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}
