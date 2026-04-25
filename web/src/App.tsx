import { NavLink, Route, Routes } from 'react-router-dom';
import { CockpitPage } from './pages/CockpitPage';
import { TerminalPage } from './pages/TerminalPage';

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">🐺</div>
          <div>
            <h1>Citadel</h1>
            <p>agent cockpit</p>
          </div>
        </div>
        <nav>
          <NavLink to="/" end>
            Cockpit
          </NavLink>
          <NavLink to="/terminal">Terminal</NavLink>
        </nav>
      </aside>
      <main className="main-shell">
        <Routes>
          <Route path="/" element={<CockpitPage />} />
          <Route path="/terminal" element={<TerminalPage />} />
        </Routes>
      </main>
    </div>
  );
}
