import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

function Hello() {
  return <h1>hello test harness</h1>;
}

describe('test harness', () => {
  it('renders a component', () => {
    render(<Hello />);
    expect(screen.getByText('hello test harness')).toBeInTheDocument();
  });
});
