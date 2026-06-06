# MVP 3: $0 Deployment

Status: locked (do after MVP 1 + 2 verified)

- [ ] Backend → Hugging Face Spaces (Docker, port 7860), set GROQ_API_KEY secret
- [ ] Mount cookies.txt secret on HF Space for Instagram auth
- [ ] Frontend → Vercel (set VITE_API_URL to HF Space URL)
- [ ] Note: SQLite on HF Spaces is ephemeral — confirm persistence need / disk
- [ ] End-to-end smoke test in production
