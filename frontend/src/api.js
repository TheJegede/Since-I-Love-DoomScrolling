export const API_BASE_URL = import.meta.env.VITE_API_URL || (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

const KEY_STORAGE = 'transcriber_api_key';

const withKey = (options, key) => (key ? { ...options, headers: { ...options.headers, 'X-API-Key': key } } : options);

export const fetchWithAuth = async (url, options = {}) => {
  const sent = localStorage.getItem(KEY_STORAGE);
  let res = await fetch(url, withKey(options, sent));
  if (res.status !== 401) return res;

  // If another request has just been given a new key, reuse it instead of prompting twice.
  const stored = localStorage.getItem(KEY_STORAGE);
  const key = stored && stored !== sent
    ? stored
    : prompt("This action needs the backend's API key (the API_AUTH_TOKEN secret on the Hugging Face Space). Enter it:")?.trim();
  if (!key) throw new Error('API key required. Click the action again and enter the API_AUTH_TOKEN value.');
  localStorage.setItem(KEY_STORAGE, key);
  res = await fetch(url, withKey(options, key));
  if (res.status === 401) {
    localStorage.removeItem(KEY_STORAGE);
    throw new Error('Wrong API key. It must match the API_AUTH_TOKEN secret on the Hugging Face Space.');
  }
  return res;
};
