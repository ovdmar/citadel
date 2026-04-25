import { Bot, MonitorSmartphone, TerminalSquare } from 'lucide-react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { CockpitPage } from './pages/CockpitPage';
import { TerminalPage } from './pages/TerminalPage';

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand brand-jarvis">
          <div className="brand-mark"><Bot size={18} /></div>
          <div>
            <h1>Citadel</h1>
            <p>operator mesh</p>
          </div>
        </div>
        <nav className="nav-rail">
          <NavLink to="/" end>
            <MonitorSmartphone size={16} />
            <span>Cockpit</span>
          </NavLink>
          <NavLink to="/terminal">
            <TerminalSquare size={16} />
            <span>Terminal</span>
          </NavLink>
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
