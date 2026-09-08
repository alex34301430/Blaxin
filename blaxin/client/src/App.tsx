import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/ChatPanel';
import { ActivityPanel } from './components/ActivityPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { SettingsModal } from './components/SettingsModal';
import { StatusBar } from './components/StatusBar';
import { ConfirmationModal } from './components/ConfirmationModal';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { MetricsPage } from './pages/MetricsPage';
import { BrainPage } from './pages/BrainPage';
import { ModelsPage } from './pages/ModelsPage';
import { SystemPage } from './pages/SystemPage';
import { SetupWizard } from './components/SetupWizard';
import { UpdateNotifier } from './components/UpdateNotifier';
import { useAppStore } from './utils/store';
import { useWebSocket } from './hooks/useWebSocket';
import { api } from './services/api';
import './theme/cyberpunk.css';

const SETUP_KEY = 'blaxin-setup-complete';

export default function App() {
  const { connected, settingsOpen, sidebarOpen, currentPage, activeModel, pendingConfirmation } = useAppStore();
  const { sendMessage, stopAgent, clearHistory, respondToConfirmation } = useWebSocket();
  const [showSetup, setShowSetup] = useState(false);

  // First-run detection
  useEffect(() => {
    const setupComplete = localStorage.getItem(SETUP_KEY);
    if (!setupComplete && !activeModel) {
      setShowSetup(true);
    }
  }, []);

  const handleSetupComplete = () => {
    localStorage.setItem(SETUP_KEY, 'true');
    setShowSetup(false);
  };

  useEffect(() => {
    // Load initial data
    const loadData = async () => {
      try {
        const [providers, models] = await Promise.all([
          api.getProviders(),
          api.getAllModels(),
        ]);
        useAppStore.getState().setProviders(providers);
        useAppStore.getState().setModels(models);
      } catch (err) {
        console.error('[BLAXIN] Failed to load initial data:', err);
      }
    };
    loadData();
  }, [connected]);

  // Keep the Brain badge honest: poll the authoritative server status
  // while connected (the server owns the connection state machine; the
  // UI only mirrors it). WebSocket brain-status events update it faster.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const refreshBrain = async () => {
      try {
        const status = await api.getBrainStatus();
        if (!cancelled) useAppStore.getState().setBrainStatus(status);
      } catch {
        /* offline — leave the last known badge */
      }
    };
    refreshBrain();
    const t = setInterval(refreshBrain, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connected]);

  return (
    <div className="app-container">
      <div className="grid-overlay" />
      
      {sidebarOpen && <Sidebar />}
      
      <main style={{ 
        flex: 1, 
        display: 'flex', 
        flexDirection: 'column',
        position: 'relative', 
        zIndex: 1,
        overflow: 'hidden',
      }}>
        <StatusBar onStop={stopAgent} onClear={clearHistory} />
        
        {currentPage === 'chat' && (
          <div style={{ 
            flex: 1, 
            display: 'flex', 
            overflow: 'hidden',
          }}>
            <ChatPanel sendMessage={sendMessage} stopAgent={stopAgent} clearHistory={clearHistory} />
            <ActivityPanel />
          </div>
        )}

        {currentPage === 'terminal' && (
          <TerminalPanel />
        )}

        {currentPage === 'metrics' && (
          <MetricsPage />
        )}

        {currentPage === 'diagnostics' && (
          <DiagnosticsPage />
        )}

        {currentPage === 'models' && (
          <ModelsPage />
        )}

        {currentPage === 'brain' && (
          <BrainPage />
        )}

        {currentPage === 'system' && (
          <SystemPage />
        )}
      </main>

      {settingsOpen && <SettingsModal />}
      {showSetup && <SetupWizard onComplete={handleSetupComplete} />}
      {!showSetup && <UpdateNotifier />}
      {pendingConfirmation && <ConfirmationModal onRespond={respondToConfirmation} />}
    </div>
  );
}
