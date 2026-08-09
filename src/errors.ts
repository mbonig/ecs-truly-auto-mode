/**
 * An error the user is meant to read, rather than a stack trace.
 *
 * Anything thrown as a CliError is printed as a message and turned into a
 * non-zero exit. Anything else is a bug and keeps its stack.
 */
export class CliError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'CliError';
  }
}
