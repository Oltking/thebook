import { useAccount, useApi } from '@gear-js/react-hooks';
import { useEffect, useState } from 'react';
import { SailsProgram } from '../lib/sails';
import { PROGRAM_ID } from '../consts';

export function useSails() {
  const { api, isApiReady } = useApi();
  const { account } = useAccount();
  const [program, setProgram] = useState<SailsProgram | null>(null);

  useEffect(() => {
    if (isApiReady && api) {
      try {
        const p = new SailsProgram(api, PROGRAM_ID as `0x${string}`);
        setProgram(p);
      } catch (e) {
        console.error('Failed to initialize SailsProgram:', e);
      }
    }
  }, [api, isApiReady]);

  return {
    program,
    account,
    isReady: isApiReady && !!program,
  };
}
