import { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { supabase } from '../supabaseClient';

export default function Login() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle');  // 'idle' | 'sending' | 'sent'
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setStatus('sending');
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // Sign-ups are off in Supabase too: only the owner's existing account can get a link.
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    if (sendError) {
      setError(sendError.message);
      setStatus('idle');
    } else {
      setStatus('sent');
    }
  };

  return (
    <main className="login-shell">
      <section className="glass login-panel">
        <div className="logo-container">
          <Clapperboard className="logo-icon" size={32} />
          <h1 className="logo-text">REEL TRANSCRIBER</h1>
        </div>
        <p className="login-copy">Sign in with a link sent to your email.</p>
        <form className="form-stack" onSubmit={handleSubmit}>
          <label className="control-label" htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            className="url-input field"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === 'sending'}
          />
          <button type="submit" className="btn-primary" disabled={status === 'sending' || !email.trim()}>
            {status === 'sending' ? 'Sending…' : 'Send sign-in link'}
          </button>
        </form>
        {status === 'sent' && <p className="login-status" role="status">Check your email for a sign-in link.</p>}
        {error && <p className="login-status login-status--error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
