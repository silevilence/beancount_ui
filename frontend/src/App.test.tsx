import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import App from './App';

it('renders the journal', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: '日用账本' })).toBeInTheDocument();
});
