import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'thebookdex_onboarding_done';

export function useOnboarding() {
  const [showWizard, setShowWizard] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const done = localStorage.getItem(STORAGE_KEY);
    if (!done) {
      setShowWizard(true);
    }
    setInitialized(true);
    // Let any component (e.g. the Header "Create Agent" button) re-open the wizard.
    const open = () => setShowWizard(true);
    window.addEventListener('thebookdex:open-wizard', open);
    return () => window.removeEventListener('thebookdex:open-wizard', open);
  }, []);

  const completeOnboarding = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setShowWizard(false);
  }, []);

  const dismissWizard = useCallback(() => {
    setShowWizard(false);
  }, []);

  return {
    showWizard: initialized && showWizard,
    completeOnboarding,
    dismissWizard,
  };
}
