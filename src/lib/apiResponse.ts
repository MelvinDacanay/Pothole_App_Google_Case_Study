/** Reject SPA fallback documents before attempting to parse an API response. */
export async function readApiJson<T>(response: Response): Promise<T> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/.test(contentType)) {
    throw new Error(
      'The community backend is unavailable on this site. Live friends and search require /api/* to be routed to the PatchUp server. Please try again after the backend is connected.'
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('The server returned an invalid JSON response. Please try again.');
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data
      && typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('The server returned an unexpected response. Please try again.');
  }
  return data as T;
}
