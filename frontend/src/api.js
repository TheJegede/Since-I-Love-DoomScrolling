export const API_BASE_URL = import.meta.env.VITE_API_URL || (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

export const fetchWithAuth = async (url, options = {}) => {
  let key = import.meta.env.VITE_API_KEY || localStorage.getItem('transcriber_api_key') || '';

  if (key) {
    options.headers = {
      ...options.headers,
      'X-API-Key': key
    };
  }

  let res = await fetch(url, options);

  if (res.status === 401) {
    const promptKey = prompt("This action requires a valid API Authentication Key. Please enter it:");
    if (promptKey) {
      localStorage.setItem('transcriber_api_key', promptKey);
      options.headers = {
        ...options.headers,
        'X-API-Key': promptKey
      };
      res = await fetch(url, options);
    }
  }
  return res;
};
