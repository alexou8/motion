import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupApp } from './App';
import '../ui/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Motion popup is missing its root element');
createRoot(container).render(<StrictMode><PopupApp /></StrictMode>);
