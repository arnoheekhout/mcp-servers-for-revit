import { withRevitConnection } from "./ConnectionManager.js";

export type TransactionMode = "auto" | "none";

/**
 * Runs a C# method body in Revit through the send_code_to_revit command.
 * Shared by tools that are implemented as generated C# snippets.
 */
export async function executeCodeInRevit(
  code: string,
  parameters: string[] = [],
  transactionMode: TransactionMode = "auto",
  timeoutSeconds: number = 600
): Promise<any> {
  return await withRevitConnection(async (revitClient) => {
    return await revitClient.sendCommand(
      "send_code_to_revit",
      { code, parameters, transactionMode, timeoutSeconds },
      (timeoutSeconds + 15) * 1000
    );
  });
}

/**
 * Formats a send_code_to_revit result. The command returns
 * { success, result, errorMessage } where result is a JSON string.
 */
export function formatExecutionResult(response: any): { ok: boolean; text: string } {
  if (response && response.success === false) {
    return { ok: false, text: response.errorMessage || "Unknown error from Revit" };
  }
  let result = response?.result;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      // keep raw string
    }
  }
  let text = JSON.stringify(result, null, 2);
  // Revit warnings are dismissed in the plugin (no modal dialog) and reported here
  if (Array.isArray(response?.warnings) && response.warnings.length > 0) {
    text += "\nRevit warnings:\n- " + response.warnings.join("\n- ");
  }
  return { ok: true, text };
}
