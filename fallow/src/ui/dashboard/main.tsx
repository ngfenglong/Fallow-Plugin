import { createRoot } from 'react-dom/client';
import '../components/theme.css';
import { App } from './App';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
