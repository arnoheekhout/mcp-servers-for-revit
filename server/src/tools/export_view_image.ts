import { z } from "zod";
import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeCodeInRevit, formatExecutionResult } from "../utils/executeCode.js";

// C# body: parameters = [outputDir, filePrefix, pixelSize, format, fitDirection, dpi, view1, view2, ...]
// Views are matched by element id or by exact name ("active" = active view).
const EXPORT_CODE = `
string outDir = (string)parameters[0];
string prefix = (string)parameters[1];
int pixelSize = int.Parse((string)parameters[2]);
string format = ((string)parameters[3]).ToLowerInvariant();
string fit = ((string)parameters[4]).ToLowerInvariant();
int dpi = int.Parse((string)parameters[5]);
Directory.CreateDirectory(outDir);

var allViews = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>()
    .Where(v => !v.IsTemplate).ToList();
var ids = new List<ElementId>();
var missing = new List<string>();
for (int i = 6; i < parameters.Length; i++)
{
    string key = (string)parameters[i];
    View match = null;
    if (key == "active") match = uidoc.ActiveView;
    else if (long.TryParse(key, out long idValue)) match = doc.GetElement(new ElementId(idValue)) as View;
    if (match == null) match = allViews.FirstOrDefault(v => v.Name == key);
    if (match == null && key.Contains(" - ")) match = allViews.OfType<ViewSheet>().FirstOrDefault(s => (s.SheetNumber + " - " + s.Name) == key);
    if (match == null) missing.Add(key); else ids.Add(match.Id);
}
if (ids.Count == 0) throw new Exception("No matching views: " + string.Join(", ", missing));

var fileType = format == "jpg" || format == "jpeg" ? ImageFileType.JPEGLossless : (format == "tif" || format == "tiff" ? ImageFileType.TIFF : ImageFileType.PNG);
ImageResolution res = dpi >= 600 ? ImageResolution.DPI_600 : dpi >= 300 ? ImageResolution.DPI_300 : dpi >= 150 ? ImageResolution.DPI_150 : ImageResolution.DPI_72;

var before = new HashSet<string>(Directory.GetFiles(outDir));
var started = DateTime.Now.AddSeconds(-2);
var opts = new ImageExportOptions
{
    ZoomType = ZoomFitType.FitToPage,
    PixelSize = pixelSize,
    FitDirection = fit == "vertical" ? FitDirectionType.Vertical : FitDirectionType.Horizontal,
    FilePath = Path.Combine(outDir, prefix),
    ExportRange = ExportRange.SetOfViews,
    HLRandWFViewsFileType = fileType,
    ShadowViewsFileType = fileType,
    ImageResolution = res,
};
opts.SetViewsAndSheets(ids);
doc.ExportImage(opts);

var files = Directory.GetFiles(outDir)
    .Where(f => !before.Contains(f) || File.GetLastWriteTime(f) >= started)
    .Select(f => Path.GetFullPath(f)).ToList();
return new { exported = files, missing = missing };
`;

export function registerExportViewImageTool(server: McpServer) {
  server.tool(
    "export_view_image",
    "Export one or more Revit views or sheets to image files (PNG/JPG/TIFF) via ImageExportOptions and return the file paths, so the result can be inspected visually. Views are given by element id, exact view name, 'SheetNumber - SheetName', or 'active'.",
    {
      views: z.array(z.string()).min(1).describe("View ids, view names, 'NUMBER - Sheet name', or 'active'"),
      outputDir: z.string().describe("Absolute output folder"),
      filePrefix: z.string().default("export").describe("File name prefix; Revit appends the view type and name"),
      pixelSize: z.number().int().min(256).max(15000).default(2000).describe("Image size in pixels along fitDirection"),
      fitDirection: z.enum(["horizontal", "vertical"]).default("horizontal"),
      format: z.enum(["png", "jpg", "tif"]).default("png"),
      dpi: z.number().int().default(150).describe("Resolution tag: 72, 150, 300 or 600"),
      timeoutSeconds: z.number().int().min(10).max(3600).default(600),
    },
    async (args) => {
      try {
        const outDir = path.resolve(args.outputDir);
        const parameters = [
          outDir,
          args.filePrefix,
          String(args.pixelSize),
          args.format,
          args.fitDirection,
          String(args.dpi),
          ...args.views,
        ];
        // Image export cannot run inside an open transaction
        const response = await executeCodeInRevit(EXPORT_CODE, parameters, "none", args.timeoutSeconds);
        const { ok, text } = formatExecutionResult(response);
        let summary = text;
        if (ok) {
          try {
            const parsed = JSON.parse(text);
            const sizes = (parsed.exported as string[]).map((f) => {
              const kb = fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) : -1;
              return `${f} (${kb} KB)`;
            });
            summary = JSON.stringify({ exported: sizes, missing: parsed.missing }, null, 2);
          } catch {
            // fall back to raw text
          }
        }
        return {
          content: [{ type: "text", text: `${ok ? "OK" : "FAILED"}\n${summary}` }],
          isError: !ok,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `export_view_image failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
