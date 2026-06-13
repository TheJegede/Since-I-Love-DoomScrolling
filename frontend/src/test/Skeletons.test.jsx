import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, TableSkeleton } from '../components/Skeletons';

describe('Skeletons', () => {
  it('Skeleton renders a shimmer card', () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector('.skeleton-card')).toBeTruthy();
  });

  it('TableSkeleton renders 5 placeholder rows', () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll('.skeleton-row').length).toBe(5);
  });
});
