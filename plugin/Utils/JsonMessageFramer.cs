using System;
using System.Collections.Generic;
using System.Text;

namespace revit_mcp_plugin.Utils
{
    /// <summary>
    /// Splits a TCP character stream into complete top-level JSON messages.
    /// TCP has no message boundaries: one Read can return part of a request
    /// (large code payloads) or several requests at once.
    /// </summary>
    public class JsonMessageFramer
    {
        // Guard against unbounded growth when a client sends garbage
        private const int MaxMessageChars = 64 * 1024 * 1024;

        private readonly StringBuilder _current = new StringBuilder();
        private int _depth;
        private bool _inString;
        private bool _escape;

        public List<string> Push(string text)
        {
            var messages = new List<string>();
            foreach (char c in text)
            {
                if (_depth == 0)
                {
                    // Skip whitespace or stray characters between messages
                    if (c == '{' || c == '[')
                    {
                        _current.Clear();
                        _current.Append(c);
                        _depth = 1;
                    }
                    continue;
                }

                _current.Append(c);
                if (_current.Length > MaxMessageChars)
                    throw new InvalidOperationException("JSON message exceeds the maximum size");

                if (_inString)
                {
                    if (_escape) _escape = false;
                    else if (c == '\\') _escape = true;
                    else if (c == '"') _inString = false;
                    continue;
                }

                if (c == '"') _inString = true;
                else if (c == '{' || c == '[') _depth++;
                else if (c == '}' || c == ']')
                {
                    _depth--;
                    if (_depth == 0)
                    {
                        messages.Add(_current.ToString());
                        _current.Clear();
                    }
                }
            }
            return messages;
        }
    }
}
