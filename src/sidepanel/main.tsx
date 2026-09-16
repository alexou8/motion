import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts.css';
import '../ui/tokens.css';
import './styles.css';
import { App } from './App';
import { createRuntimeBridge, startLocalInferenceHost } from './runtimeBridge';

const root = document.getElementById('root');
if (!root) throw new Error('Motion panel root is missing.');

// The bridge is the panel's only connection to the extension runtime; every
// view below it is a pure function of PanelState.
createRoot(root).render(
  <StrictMode>
    <App bridge={createRuntimeBridge()} />
  </StrictMode>,
);

// Platform wiring, not a React concern: serves Chrome's on-device model to
// the worker for as long as this panel stays open (ARCH D2).
startLocalInferenceHost();
