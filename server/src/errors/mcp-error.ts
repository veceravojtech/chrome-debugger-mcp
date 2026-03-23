export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly resource: Record<string, unknown>,
    public readonly hint: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'McpError';
  }

  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      resource: this.resource,
      hint: this.hint,
      recoverable: this.recoverable,
    };
  }
}
