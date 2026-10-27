import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import GameLanding from './pages/GameLanding';
import NotesApp from './pages/NotesApp';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<GameLanding />} />
        <Route path="/notes" element={<NotesApp />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);