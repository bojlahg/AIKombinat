export function evaluationCsvCell(value: unknown): string {
  let text=value===null || value===undefined ? '' : String(value);
  if (/^\s*[=+@\-]|^[\t\r\n]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
