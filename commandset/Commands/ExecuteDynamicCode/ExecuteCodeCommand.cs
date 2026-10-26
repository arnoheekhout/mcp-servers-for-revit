using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Base;

namespace RevitMCPCommandSet.Commands.ExecuteDynamicCode
{
    /// <summary>
    /// 处理代码执行的命令类
    /// </summary>
    public class ExecuteCodeCommand : ExternalEventCommandBase
    {
        private ExecuteCodeEventHandler _handler => (ExecuteCodeEventHandler)Handler;

        public override string CommandName => "send_code_to_revit";

        public ExecuteCodeCommand(UIApplication uiApp)
            : base(new ExecuteCodeEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                // 参数验证
                if (!parameters.ContainsKey("code"))
                {
                    throw new ArgumentException("Missing required parameter: 'code'");
                }

                // 解析代码和参数
                string code = parameters["code"].Value<string>();
                JArray parametersArray = parameters["parameters"] as JArray;
                object[] executionParameters = parametersArray?.ToObject<object[]>() ?? Array.Empty<object>();
                string transactionMode = parameters["transactionMode"]?.Value<string>() ?? ExecuteCodeEventHandler.TransactionModeAuto;
                int timeoutSeconds = parameters["timeoutSeconds"]?.Value<int>() ?? 600;

                // 设置执行参数
                _handler.SetExecutionParameters(code, executionParameters, transactionMode);

                // 触发外部事件并等待完成
                if (RaiseAndWaitForCompletion(timeoutSeconds * 1000))
                {
                    return _handler.ResultInfo;
                }
                else
                {
                    throw new TimeoutException($"Code execution did not finish within {timeoutSeconds} s (Revit may be busy or showing a dialog).");
                }
            }
            catch (Exception ex)
            {
                throw new Exception($"send_code_to_revit failed: {ex.Message}", ex);
            }
        }
    }
}
