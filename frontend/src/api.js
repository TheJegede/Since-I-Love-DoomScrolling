export const API_BASE_URL = import.meta.env.VITE_API_URL || (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

const KEY_STORAGE = 'transcriber_api_key';

const withKey = (options, key) => (key ? { ...options, headers: { ...options.headers, 'X-API-Key': key } } : options);

export const fetchWithAuth = async (url, options = {}) => {
  let res = await fetch(url, withKey(options, localStorage.getItem(KEY_STORAGE)));
  if (res.status !== 401) return res;

  const typed = prompt("This action needs the backend's API key (the API_AUTH_TOKEN secret on the Hugging Face Space). Enter it:")?.trim();
  if (!typed) throw new Error('API key required. Click the action again and enter the API_AUTH_TOKEN value.');
  res = await fetch(url, withKey(options, typed));
  if (res.status === 401) {
    localStorage.removeItem(KEY_STORAGE);
    throw new Error('Wrong API key. It must match the API_AUTH_TOKEN secret on the Hugging Face Space.');
  }
  localStorage.setItem(KEY_STORAGE, typed);
  return res;
};
