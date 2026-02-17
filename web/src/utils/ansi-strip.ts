/**
 * Strip ANSI escape codes from a string.
 * Handles SGR (colors/styles), cursor movement, and OSC (operating system commands).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape matching
const ANSI_PATTERN = /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}
