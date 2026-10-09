const workerUrl = (import.meta.env.VITE_WORKER_API_URL || '').replace(/\/$/, '');

export async function workerRequest(accessToken, path, options = {}) {
  if (!workerUrl) throw new Error('VITE_WORKER_API_URL 설정을 확인해 주세요.');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (options.body) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${workerUrl}${path}`, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Worker 요청 오류 (${response.status})`);
  return result;
}