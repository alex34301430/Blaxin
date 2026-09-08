import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '../utils/store';

interface UseVoiceOptions {
  onTranscript?: (transcript: string) => void;
  onFinalTranscript?: (transcript: string) => void;
}

interface UseVoiceReturn {
  startListening: () => void;
  stopListening: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  isSupported: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  /** Human-readable last STT failure (null when OK). */
  voiceError: string | null;
}

export function useVoice(options?: UseVoiceOptions): UseVoiceReturn {
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isSpeakingState, setIsSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const {
    voiceEnabled,
    ttsEnabled,
    isListening,
    setIsListening,
    setVoiceTranscript,
  } = useAppStore();

  const isSupported = typeof window !== 'undefined' && 
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const isSpeaking = isSpeakingState;

  // Initialize speech recognition
  useEffect(() => {
    if (!isSupported) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (interimTranscript) {
        setVoiceTranscript(interimTranscript);
        options?.onTranscript?.(interimTranscript);
      }

      if (finalTranscript) {
        setVoiceTranscript(finalTranscript);
        options?.onFinalTranscript?.(finalTranscript);
        setIsListening(false);
      }
    };

    recognition.onerror = (event: any) => {
      // Voice failures must be visible, not just console noise.
      const code = String(event.error || 'unknown');
      let message: string | null = null;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        message = 'Microphone permission denied — allow the microphone to use voice input.';
      } else if (code === 'audio-capture') {
        message = 'No microphone detected.';
      } else if (code === 'no-speech') {
        message = 'No speech detected — try again.';
      } else if (code === 'network') {
        message = 'Speech service unreachable (offline?).';
      } else if (code === 'aborted') {
        message = null; // user cancelled — not an error
      } else {
        message = `Voice input error: ${code}.`;
      }
      setVoiceError(message);
      setIsListening(false);
      if (message && errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setVoiceError(null), 5000);
      console.warn('[BLAXIN] Speech recognition error:', code);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      try {
        recognition.abort();
      } catch {}
    };
  }, [isSupported]);

  // Initialize speech synthesis
  useEffect(() => {
    synthRef.current = window.speechSynthesis || null;
    if (!synthRef.current) return;

    const handleSpeaking = () => setIsSpeaking(true);
    const handleSilent = () => setIsSpeaking(false);
    synthRef.current.addEventListener('start', handleSpeaking);
    synthRef.current.addEventListener('end', handleSilent);
    synthRef.current.addEventListener('pause', handleSilent);
    synthRef.current.addEventListener('error', handleSilent);

    return () => {
      synthRef.current?.removeEventListener('start', handleSpeaking);
      synthRef.current?.removeEventListener('end', handleSilent);
      synthRef.current?.removeEventListener('pause', handleSilent);
      synthRef.current?.removeEventListener('error', handleSilent);
    };
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current || isListening) return;
    
    try {
      // Stop any ongoing speech
      synthRef.current?.cancel();
      
      recognitionRef.current.start();
      setIsListening(true);
      setVoiceTranscript('');
      setVoiceError(null);
    } catch (err) {
      setVoiceError('Could not start voice input — check the microphone.');
      console.error('[BLAXIN] Failed to start recognition:', err);
    }
  }, [isListening]);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;
    
    try {
      recognitionRef.current.stop();
    } catch {}
    setIsListening(false);
  }, []);

  const speak = useCallback((text: string) => {
    if (!synthRef.current || !ttsEnabled) return;

    // Cancel any ongoing speech
    synthRef.current.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.lang = 'en-US';

    // Pick a good voice if available
    const voices = synthRef.current.getVoices();
    const preferredVoice = voices.find(v => 
      v.name.includes('Google') && v.lang.startsWith('en')
    ) || voices.find(v => 
      v.lang.startsWith('en') && v.localService === false
    ) || voices.find(v => 
      v.lang.startsWith('en')
    );
    
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    utteranceRef.current = utterance;
    synthRef.current.speak(utterance);
  }, [ttsEnabled]);

  const stopSpeaking = useCallback(() => {
    synthRef.current?.cancel();
  }, []);

  return {
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    isSupported,
    isListening,
    isSpeaking,
    voiceError,
  };
}
