// Thin fetch wrapper. Every error the server sends is already Hebrew and
// meant for the user, so it is surfaced as-is.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      // The server refuses writes without this header (CSRF guard).
      headers: body === undefined ? { 'X-Memory-App': '1' } : { 'Content-Type': 'application/json', 'X-Memory-App': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('אין חיבור לשרת המקומי. האם המערכת פועלת?', 0);
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `שגיאה (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  async upload<T>(url: string, file: File, meta: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`/api${url}`, {
      method: 'POST',
      headers: {
        'X-Memory-App': '1',
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        'X-Meta': encodeURIComponent(JSON.stringify(meta)),
      },
      body: file,
    });
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `שגיאה (${res.status})`, res.status);
    return data as T;
  },
};

export function sourceFileUrl(sourceId: number, locatorType?: string | null, locatorNum?: number | null, ext?: string | null): string {
  const base = `/api/sources/${sourceId}/file`;
  // Browsers' PDF viewers honour #page=N; other formats just open.
  if ((ext === '.pdf' || locatorType === 'page') && locatorNum) return `${base}#page=${locatorNum}`;
  return base;
}
