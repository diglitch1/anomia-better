export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Provider errors can echo the request, so only the name and status are logged.
export function logProviderError(where: string, err: unknown): void {
  const e = err as { name?: string; statusCode?: number; status?: number };
  console.error(`${where} failed: ${e?.name ?? "Error"} status=${e?.statusCode ?? e?.status ?? "none"}`);
}
