# Plan 008: Fix Vitest Async act Warnings

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9537dd6..HEAD -- frontend/src/test/App.test.jsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

When running `npm run test` on the frontend, Vitest logs several warnings about async updates not being wrapped in `act(...)`. This happens because `App.jsx` triggers asynchronous database and server health checks in `useEffect` hooks immediately on mount. If a test asserts on the rendering and finishes before these async hooks finish executing, React schedules state changes after the test terminates, triggering console warnings.

Fixing these warnings ensures clean test suite outputs, making it easier to notice genuine test failures.

## Current state

- Relevant files:
  - `frontend/src/test/App.test.jsx` — contains unit tests for the App shell.
- Warning output in console:
  `An update to App inside a test was not wrapped in act(...).`
- Excerpt from `frontend/src/test/App.test.jsx` (lines 23–36):
  ```javascript
  describe('App baseline', () => {
    it('renders the header', () => {
      render(<App />);
      expect(screen.getByText('Transcriber')).toBeInTheDocument();
    });
  
    it('renders the four ingestion mode tabs', () => {
      render(<App />);
      expect(screen.getByText('Reel URL')).toBeInTheDocument();
      expect(screen.getByText('Audio File')).toBeInTheDocument();
      expect(screen.getByText('Transcript Text')).toBeInTheDocument();
      expect(screen.getByText('Bulk Import')).toBeInTheDocument();
    });
  ```

## Commands you will need

| Purpose   | Command                         | Expected on success |
|-----------|---------------------------------|---------------------|
| Tests     | `cd frontend && npm run test`   | all tests pass      |

## Scope

**In scope**:
- `frontend/src/test/App.test.jsx`

**Out of scope**:
- Source code logic in `frontend/src/App.jsx` (the tests must adapt to the component lifecycle, not the other way around).

## Steps

### Step 1: Make baseline tests async and wait for resolves

Open `frontend/src/test/App.test.jsx`. Update the first two tests in `App baseline` to be async functions. Add an expectation or a `screen.findByText` query at the end of each test to wait for the async data fetch state to complete (indicated by the render of the empty state or loaded state).

Target shape:
```javascript
describe('App baseline', () => {
  it('renders the header', async () => {
    render(<App />);
    expect(screen.getByText('Transcriber')).toBeInTheDocument();
    // Await async mount fetches to resolve and update state
    await screen.findByText(/No extractions found/i);
  });

  it('renders the four ingestion mode tabs', async () => {
    render(<App />);
    expect(screen.getByText('Reel URL')).toBeInTheDocument();
    expect(screen.getByText('Audio File')).toBeInTheDocument();
    expect(screen.getByText('Transcript Text')).toBeInTheDocument();
    expect(screen.getByText('Bulk Import')).toBeInTheDocument();
    // Await async mount fetches to resolve and update state
    await screen.findByText(/No extractions found/i);
  });
```

**Verify**: Run `cd frontend && npm run test` and check that the console output contains zero `act(...)` warnings.

## Test plan

- Run: `cd frontend && npm run test` -> all tests pass cleanly without warning logs.

## Done criteria

- [ ] Frontend tests complete successfully with 0 warnings in the console.
- [ ] No files outside `frontend/src/test/App.test.jsx` are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If tests timeout waiting for elements (resolved by ensuring the mock fetch resolves correctly).

## Maintenance notes

- If new async endpoints are called inside mount `useEffect` hooks, the test mock fetches in `App.test.jsx` must mock those endpoints to prevent pending promises.
