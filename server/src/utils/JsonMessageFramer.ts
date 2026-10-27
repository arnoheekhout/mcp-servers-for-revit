// Splits a TCP character stream into complete top-level JSON messages.
// TCP has no message boundaries: one "data" event can hold part of a response
// or several responses back to back.
export class JsonMessageFramer {
  private current = "";
  private depth = 0;
  private inString = false;
  private escape = false;

  push(text: string): string[] {
    const messages: string[] = [];
    let start = this.depth > 0 ? 0 : -1;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (this.depth === 0) {
        // Skip whitespace or stray characters between messages
        if (c === "{" || c === "[") {
          this.current = "";
          this.depth = 1;
          start = i;
        }
        continue;
      }

      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === "\\") this.escape = true;
        else if (c === '"') this.inString = false;
        continue;
      }

      if (c === '"') this.inString = true;
      else if (c === "{" || c === "[") this.depth++;
      else if (c === "}" || c === "]") {
        this.depth--;
        if (this.depth === 0) {
          messages.push(this.current + text.slice(start, i + 1));
          this.current = "";
          start = -1;
        }
      }
    }

    // Keep the unfinished tail for the next chunk
    if (this.depth > 0 && start >= 0) this.current += text.slice(start);
    return messages;
  }
}
