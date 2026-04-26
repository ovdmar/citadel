import { CalendarClock, LayoutPanelTop, PanelRightOpen, TerminalSquare } from 'lucide-react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { CockpitPage } from './pages/CockpitPage';
import { CronsPage } from './pages/CronsPage';
import { OpenClawPage } from './pages/OpenClawPage';
import { SystemTerminalPage } from './pages/SystemTerminalPage';

export default function App() {
  const location = useLocation();
  const showOpenClaw = location.pathname === '/openclaw';
  const showSystemTerminal = location.pathname === '/terminal';

  return (
    <div className="app-shell app-shell-single">
      <main className="main-shell main-shell-full app-main-with-nav">
        <div className="app-top-nav-shell">
          <NavLink to="/" end className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <LayoutPanelTop size={15} /> Workspaces
          </NavLink>
          <NavLink to="/openclaw" className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <PanelRightOpen size={15} /> OpenClaw
          </NavLink>
          <NavLink to="/terminal" className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <TerminalSquare size={15} /> Terminal
          </NavLink>
          <NavLink to="/crons" className={({ isActive }) => `app-top-nav-link ${isActive ? 'active' : ''}`}>
            <CalendarClock size={15} /> Crons
          </NavLink>
        </div>
        <div className="app-page-slot app-page-slot-keepalive">
          <div className={`app-page-panel ${showOpenClaw ? 'active' : 'inactive'}`} aria-hidden={!showOpenClaw}>
            <OpenClawPage />
          </div>
          <div className={`app-page-panel ${showSystemTerminal ? 'active' : 'inactive'}`} aria-hidden={!showSystemTerminal}>
            <SystemTerminalPage />
          </div>
          <div className={`app-page-panel ${showOpenClaw || showSystemTerminal ? 'inactive' : 'active'}`} aria-hidden={showOpenClaw || showSystemTerminal}>
            <Routes>
              <Route path="/" element={<CockpitPage />} />
              <Route path="/crons" element={<CronsPage />} />
            </Routes>
          </div>
        </div>
      </main>
    </div>
  );
}
