import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../supabaseClient', async (importOriginal) => {
  const { createFakeSupabase } = await import('./fakeSupabase');
  const fake = createFakeSupabase();
  return { ...(await importOriginal()), supabase: fake.client, __fake: fake };
});

import { __fake as fake } from '../supabaseClient';
import App from '../App';

const OWNER = { user: { id: 'owner', email: 'me@example.com' } };
const reelQueries = () => fake.log.filter(c => c.table === 'saved_reels');

beforeEach(() => {
  fake.tables = { saved_reels: [], cluster_jobs: [], worker_status: [] };
  fake.log.length = 0;
  fake.failures.length = 0;
  fake.session = null;
});

describe('sign-in gate', () => {
  it('shows login and never queries reels when signed out', async () => {
    render(<App />);
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText(/Saved Extracted Insights/)).toBeNull();
    expect(reelQueries()).toHaveLength(0);
  });

  it('shows the library when signed in', async () => {
    fake.session = OWNER;
    render(<App />);
    expect(await screen.findByText(/No extractions found/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('returns to login on SIGNED_OUT', async () => {
    fake.session = OWNER;
    render(<App />);
    await screen.findByText(/No extractions found/i);
    act(() => fake.setSession(null));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('signs out of this device only', async () => {
    fake.session = OWNER;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    const [{ args: [options] }] = fake.log.filter(c => c.method === 'signOut');
    expect(options).toEqual({ scope: 'local' });  // the default ('global') would sign the phone out too
  });

  it('says so when signing out fails', async () => {
    fake.session = OWNER;
    fake.failNext('auth', 'signOut', { message: 'Failed to fetch' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Could not sign out: Failed to fetch')).toBeInTheDocument();
  });

  it('explains an expired or already-used sign-in link', async () => {
    window.history.replaceState(null, '', '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    try {
      render(<App />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Email link is invalid or has expired');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('requests a link without creating users', async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: ' me@example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByText('Check your email for a sign-in link.')).toBeInTheDocument();
    const [{ args: [request] }] = fake.log.filter(c => c.method === 'signInWithOtp');
    expect(request).toEqual({
      email: 'me@example.com',
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
  });

  it('shows Supabase\'s error when the link cannot be sent', async () => {
    fake.failNext('auth', 'signInWithOtp', { message: 'Signups not allowed for otp' });
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'stranger@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Signups not allowed for otp'));
  });
});
