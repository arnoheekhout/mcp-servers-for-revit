using System.IO;
using System.Reflection;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Newtonsoft.Json;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Commands.ExecuteDynamicCode
{
    /// <summary>
    /// 处理代码执行的外部事件处理器
    /// </summary>
    public class ExecuteCodeEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        public const string TransactionModeAuto = "auto";
        public const string TransactionModeNone = "none";

        // Number of lines in the wrapper template before the user code starts,
        // used to translate compiler line numbers back to the user's snippet.
        private const int UserCodeLineOffset = 21;

        // 代码执行参数
        private string _generatedCode;
        private object[] _executionParameters;
        private string _transactionMode = TransactionModeAuto;

        // 执行结果信息
        public ExecutionResultInfo ResultInfo { get; private set; }

        // 状态同步对象
        public bool TaskCompleted { get; private set; }
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        // 设置要执行的代码和参数
        public void SetExecutionParameters(string code, object[] parameters = null, string transactionMode = TransactionModeAuto)
        {
            _generatedCode = code;
            _executionParameters = parameters ?? Array.Empty<object>();
            _transactionMode = transactionMode == TransactionModeNone ? TransactionModeNone : TransactionModeAuto;
            TaskCompleted = false;
            _resetEvent.Reset();
        }

        // 等待执行完成 - IWaitableExternalEventHandler接口实现
        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            // The event is already reset in SetExecutionParameters. Resetting here again
            // could swallow a completion signal when Revit runs the handler quickly.
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        // Warnings and errors raised while the user code runs. Revit would otherwise
        // show them in a modal dialog, which blocks every following MCP request.
        private readonly List<string> _failures = new List<string>();
        private bool _hadErrors;

        private void OnFailuresProcessing(object sender, Autodesk.Revit.DB.Events.FailuresProcessingEventArgs e)
        {
            var accessor = e.GetFailuresAccessor();
            bool hasError = false;
            foreach (var message in accessor.GetFailureMessages())
            {
                var severity = message.GetSeverity();
                string text = $"{severity}: {message.GetDescriptionText()} ({message.GetFailingElementIds().Count} elements)";
                if (!_failures.Contains(text)) _failures.Add(text);
                if (severity == FailureSeverity.Warning) accessor.DeleteWarning(message);
                else hasError = true;
            }
            if (hasError)
            {
                // Roll back instead of asking the user; the errors are reported in the result
                _hadErrors = true;
                e.SetProcessingResult(FailureProcessingResult.ProceedWithRollBack);
            }
            else
            {
                e.SetProcessingResult(FailureProcessingResult.Continue);
            }
        }

        public void Execute(UIApplication app)
        {
            _failures.Clear();
            _hadErrors = false;
            app.Application.FailuresProcessing += OnFailuresProcessing;
            try
            {
                // Without an open project only transactionMode "none" can run (doc is null),
                // which lets scripts create or open documents themselves.
                var doc = app.ActiveUIDocument?.Document;
                if (doc == null && _transactionMode != TransactionModeNone)
                    throw new InvalidOperationException("No active Revit document. Open or create a project first, or use transactionMode 'none'.");
                ResultInfo = new ExecutionResultInfo();

                object result;
                if (_transactionMode == TransactionModeNone)
                {
                    result = CompileAndExecuteCode(
                        code: _generatedCode,
                        doc: doc,
                        uiApp: app,
                        parameters: _executionParameters
                    );
                }
                else
                {
                    using (var transaction = new Transaction(doc, "MCP: execute code"))
                    {
                        transaction.Start();

                        result = CompileAndExecuteCode(
                            code: _generatedCode,
                            doc: doc,
                            uiApp: app,
                            parameters: _executionParameters
                        );

                        if (transaction.GetStatus() == TransactionStatus.Started &&
                            transaction.Commit() == TransactionStatus.RolledBack)
                            throw new InvalidOperationException("Transaction rolled back by Revit:\n" + string.Join("\n", _failures));
                    }
                }

                ResultInfo.Success = true;
                ResultInfo.Result = JsonConvert.SerializeObject(result);
                ResultInfo.Warnings = _failures.ToList();
                if (_hadErrors) ResultInfo.Warnings.Insert(0, "At least one transaction was rolled back because of errors.");
            }
            catch (Exception ex)
            {
                // Unwrap reflection wrappers so the caller sees the real exception
                var inner = ex;
                while (inner is TargetInvocationException && inner.InnerException != null)
                    inner = inner.InnerException;
                ResultInfo ??= new ExecutionResultInfo();
                ResultInfo.Success = false;
                ResultInfo.ErrorMessage = $"Execution failed: {inner.GetType().Name}: {inner.Message}\n{inner.StackTrace}";
            }
            finally
            {
                app.Application.FailuresProcessing -= OnFailuresProcessing;
                TaskCompleted = true;
                _resetEvent.Set();
            }
        }

        private object CompileAndExecuteCode(string code, Document doc, UIApplication uiApp, object[] parameters)
        {
            // 包装代码以规范入口点
            var wrappedCode = $@"
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;

namespace AIGeneratedCode
{{
    public static class CodeExecutor
    {{
        public static object Execute(Document document, object[] parameters, UIApplication uiapp)
        {{
            var doc = document;
            var uidoc = uiapp.ActiveUIDocument;
            var app = uiapp.Application;
            // user code
{code}
        }}
    }}
}}";

            var syntaxTree = CSharpSyntaxTree.ParseText(wrappedCode);

            // 添加必要的程序集引用（引用所有已加载的程序集）
            // Other add-ins can load their own copy of an assembly (same simple name,
            // different file), which Roslyn rejects as a duplicate import. Keep one
            // per name, preferring the copy that ships with Revit itself.
            string revitDir = Path.GetDirectoryName(typeof(Document).Assembly.Location) ?? "";
            var references = AppDomain.CurrentDomain.GetAssemblies()
                .Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
                .GroupBy(a => a.GetName().Name, StringComparer.OrdinalIgnoreCase)
                .Select(g => g.OrderByDescending(a => string.Equals(Path.GetDirectoryName(a.Location), revitDir, StringComparison.OrdinalIgnoreCase))
                              .ThenByDescending(a => a.GetName().Version)
                              .First())
                .Select(a => MetadataReference.CreateFromFile(a.Location))
                .Cast<MetadataReference>()
                .ToList();

            // 编译代码
            var compilation = CSharpCompilation.Create(
                "AIGeneratedCode",
                syntaxTrees: new[] { syntaxTree },
                references: references,
                options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            );

            using (var ms = new MemoryStream())
            {
                var result = compilation.Emit(ms);

                // 处理编译结果
                if (!result.Success)
                {
                    var errors = string.Join("\n", result.Diagnostics
                        .Where(d => d.Severity == DiagnosticSeverity.Error)
                        .Select(d =>
                        {
                            int line = d.Location.GetLineSpan().StartLinePosition.Line - UserCodeLineOffset + 1;
                            return line >= 1 ? $"Line {line}: {d.GetMessage()}" : $"(wrapper/global): {d.GetMessage()}";
                        }));
                    throw new Exception($"Compilation failed:\n{errors}");
                }

                // 反射调用执行方法
                ms.Seek(0, SeekOrigin.Begin);
                var assembly = Assembly.Load(ms.ToArray());
                var executorType = assembly.GetType("AIGeneratedCode.CodeExecutor");
                var executeMethod = executorType.GetMethod("Execute");

                return executeMethod.Invoke(null, new object[] { doc, parameters, uiApp });
            }
        }

        public string GetName()
        {
            return "MCP: execute code";
        }
    }

    // 执行结果数据结构
    public class ExecutionResultInfo
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("result")]
        public string Result { get; set; }

        [JsonProperty("errorMessage")]
        public string ErrorMessage { get; set; } = string.Empty;

        // Revit warnings/errors that were handled without a dialog
        [JsonProperty("warnings")]
        public List<string> Warnings { get; set; } = new List<string>();
    }
}
