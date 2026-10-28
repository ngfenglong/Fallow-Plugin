import { render, screen } from '@testing-library/react';
import { Heading } from '../../src/ui/dashboard/main';

it('transforms and renders a .tsx component under vitest', () => {
  render(<Heading />);
  expect(screen.getByRole('heading')).toHaveTextContent('Fallow dashboard');
});
