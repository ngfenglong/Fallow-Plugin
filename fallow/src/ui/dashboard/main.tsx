import { createRoot } from 'react-dom/client';

// Placeholder; replaced by a later task.
export function Heading() {
  return <h1>Fallow dashboard</h1>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Heading />);
