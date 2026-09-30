import { StringDecoder } from 'node:string_decoder';

export class AccountOutputRedactor {
  private pending = '';
  private decoder = new StringDecoder('utf8');
  constructor(private secrets: readonly string[]) {}
  write(chunk: string | Buffer, final = false): string {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (final) this.pending += this.decoder.end();
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) this.pending = this.pending.split(secret).join('***redacted***');
    let end = this.pending.length;
    if (!final) {
      for (const secret of this.secrets) {
        for (let length = 1; length < secret.length && length <= this.pending.length; length++) {
          if (this.pending.endsWith(secret.slice(0, length))) end = Math.min(end, this.pending.length - length);
        }
      }
    }
    let output = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) output = output.split(secret).join('***redacted***');
    return output;
  }
}
