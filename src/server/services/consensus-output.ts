export class ConsensusOutputCollector {
  private pending = '';
  private text = '';
  private finalText: string | null = null;
  private droppingLine = false;
  overflow = false;
  diagnostic = '';
  usage: { input_tokens: number | null; output_tokens: number | null; cost_usd: number | null } = { input_tokens: null,output_tokens: null,cost_usd: null };
  constructor(private structured: boolean) {}
  push(chunk: string): void {
    if (!this.structured) { this.text = this.bound(this.text + chunk);return; }
    this.pending += chunk;
    while (this.pending.includes('\n')) {
      const at = this.pending.indexOf('\n'), line = this.pending.slice(0,at);this.pending = this.pending.slice(at+1);
      if (!this.droppingLine) this.line(line);
      this.droppingLine = false;
    }
    if (Buffer.byteLength(this.pending) > 256 * 1024) { this.pending = '';this.droppingLine = true; }
  }
  finish(): string {
    if (this.pending && !this.droppingLine) this.line(this.pending);
    this.pending = '';return this.finalText ?? this.text;
  }
  private bound(value: string): string {
    if (Buffer.byteLength(value) <= 64 * 1024) return value;
    this.overflow = true;return value.slice(-32 * 1024);
  }
  private line(line: string): void {
    if (!line.trim()) return;
    try {
      const data = JSON.parse(line);
      if (data.type === 'assistant') {
        for (const block of data.message?.content ?? []) if (block.type === 'text' && typeof block.text === 'string') this.text = this.bound(this.text + block.text);
      } else if (data.type === 'result') {
        if (typeof data.result === 'string') this.finalText = this.bound(data.result);
        if (Array.isArray(data.errors)) this.diagnostic = data.errors.filter((e: unknown) => typeof e === 'string').join('; ').slice(-8192);
        const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
        this.usage = { input_tokens: finite(data.usage?.input_tokens),output_tokens: finite(data.usage?.output_tokens),cost_usd: finite(data.total_cost_usd) };
      } else if (data.verdict) this.text = this.bound(this.text + line);
    } catch { this.text = this.bound(this.text + line + '\n'); }
  }
}
