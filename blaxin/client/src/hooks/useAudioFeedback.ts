import { useEffect, useRef } from 'react';
import { useAppStore } from '../utils/store';
import { audioIdentity, AudioEvent } from '../services/audio';

// Map real agent states to JARVIS events. Only transitions trigger sounds.
const STATE_TO_EVENT: Record<string, AudioEvent> = {
  thinking: 'THINKING',
  planning: 'PLANNING',
  executing: 'ACTION_STARTED',
  observing: 'OBSERVATION',
  completed: 'TASK_COMPLETED',
  error: 'ERROR',
  'requires-confirmation': 'PERMISSION_REQUIRED',
};

const WORKING_STATES = ['thinking', 'planning', 'executing', 'observing', 'waiting', 'requires-confirmation'];

/** JARVIS audio identity: event sounds driven by REAL store transitions. */
export function useAudioFeedback(): void {
  const agentState = useAppStore((s) => s.agentState);
  const connected = useAppStore((s) => s.connected);
  const isListening = useAppStore((s) => s.isListening);
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const audioVolume = useAppStore((s) => s.audioVolume);

  const prev = useRef({ agentState, connected, isListening, booted: false });

  // Mute/volume follow the store (persisted preferences).
  useEffect(() => { audioIdentity.setMuted(!audioEnabled); }, [audioEnabled]);
  useEffect(() => { audioIdentity.setVolume(audioVolume); }, [audioVolume]);

  useEffect(() => {
    const p = prev.current;
    if (!p.booted) {
      // First render: announce the app is up (no fake mid-run sounds).
      p.booted = true;
      p.agentState = agentState;
      p.connected = connected;
      p.isListening = isListening;
      if (connected) audioIdentity.play('STARTUP');
      return;
    }

    if (connected && !p.connected) audioIdentity.play('CONNECTED');
    if (!connected && p.connected) audioIdentity.play('DISCONNECTED');
    if (isListening && !p.isListening) audioIdentity.play('LISTENING');

    if (agentState !== p.agentState) {
      const ev = STATE_TO_EVENT[agentState];
      if (ev) audioIdentity.play(ev);
      // A task stopped mid-run unwinds to idle — sound the cancellation.
      if (agentState === 'idle' && WORKING_STATES.includes(p.agentState)) {
        audioIdentity.play('CANCELLED');
      }
    }

    p.agentState = agentState;
    p.connected = connected;
    p.isListening = isListening;
  }, [agentState, connected, isListening]);
}

/** Unlock browser audio on the first user gesture (autoplay policy). */
export function useAudioUnlock(): void {
  useEffect(() => {
    const unlock = () => audioIdentity.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
}