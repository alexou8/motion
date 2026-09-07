import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts.css';
import '../ui/tokens.css';
import './styles.css';
import { App } from './App';
import { createRuntimeBridge } from './runtimeBridge';

const root = document.getElementById('root');
if (!root) throw new Error('Motion panel root is missing.');

// The bridge is the panel's only connection to the extension runtime; every
// view below it is a pure function of PanelState.
createRoot(root).render(
  <StrictMode>
    <App bridge={createRuntimeBridge()} />
  </StrictMode>,
);
