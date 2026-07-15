import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TransactionBuilder } from 'sails-js';
import { web3FromSource } from '@polkadot/extension-dapp';
import { Loader2, CheckCircle2, XCircle, ArrowRight, Wallet, SendHorizonal, Clock } from 'lucide-react';
import styles from './TxStatus.module.css';

type TxStage = 'idle' | 'signing' | 'broadcasting' | 'confirming' | 'confirmed' | 'failed';

interface TxStep {
  stage: TxStage;
  label: string;
  icon: ReactNode;
}

const STEPS: TxStep[] = [
  { stage: 'signing', label: 'Signing transaction', icon: <Wallet size={18} /> },
  { stage: 'broadcasting', label: 'Broadcasting to network', icon: <SendHorizonal size={18} /> },
  { stage: 'confirming', label: 'Waiting for confirmation', icon: <Clock size={18} /> },
  { stage: 'confirmed', label: 'Transaction confirmed', icon: <CheckCircle2 size={18} /> },
];

interface TxState {
  visible: boolean;
  stage: TxStage;
  message: string;
  errorMsg: string;
}

interface UseTxStatusReturn {
  txState: TxState;
  executeTx: (
    buildTx: () => TransactionBuilder<unknown>,
    account: { address: string; meta: { source: string } },
    onSuccess?: () => void,
  ) => Promise<string | null>;
  resetTx: () => void;
}

export function useTxStatus(): UseTxStatusReturn {
  const [txState, setTxState] = useState<TxState>({
    visible: false,
    stage: 'idle',
    message: '',
    errorMsg: '',
  });
  const stageRef = useRef<TxStage>('idle');
  const errorRef = useRef<string>('');

  const updateStage = useCallback((stage: TxStage, message?: string) => {
    stageRef.current = stage;
    if (stage === 'failed') {
      errorRef.current = message || '';
    }
    setTxState(prev => ({
      ...prev,
      visible: true,
      stage,
      message: message || STEPS.find(s => s.stage === stage)?.label || '',
      errorMsg: stage === 'failed' ? (message || '') : '',
    }));
  }, []);

  const executeTx = useCallback(async (
    buildTx: () => TransactionBuilder<unknown>,
    account: { address: string; meta: { source: string } },
    onSuccess?: () => void,
  ): Promise<string | null> => {
    try {
      updateStage('signing');
      const { signer } = await web3FromSource(account.meta.source);

      updateStage('broadcasting');
      const transaction = buildTx();
      // Gas safety: the node returns the *minimum* limit, which under-estimates real
      // cost and causes intermittent "ran out of gas" failures. Add the max buffer.
      await transaction.withAccount(account.address, { signer }).calculateGas(true, 100);

      updateStage('confirming');
      const { response } = await transaction.signAndSend();
      const result = await response();

      /* Contract returned Result<T, E> → { err: E } means the method failed */
      if (result !== null && result !== undefined && typeof result === 'object' && 'err' in (result as object)) {
        const errVal = (result as any).err;
        const errMsg = typeof errVal === 'string' ? errVal : JSON.stringify(errVal);
        updateStage('failed', errMsg);
        return errMsg;
      }

      updateStage('confirmed', 'Transaction confirmed successfully');
      onSuccess?.();
      return null;
    } catch (e: any) {
      const msg = e?.message || String(e);
      updateStage('failed', msg.length > 100 ? 'Transaction failed' : msg);
      return errorRef.current || msg;
    }
  }, [updateStage]);

  const resetTx = useCallback(() => {
    stageRef.current = 'idle';
    errorRef.current = '';
    setTxState({ visible: false, stage: 'idle', message: '', errorMsg: '' });
  }, []);

  return { txState, executeTx, resetTx };
}

export function TxStatusOverlay({ state, onClose }: { state: TxState; onClose: () => void }) {
  const confirmed = state.stage === 'confirmed';
  const failed = state.stage === 'failed';

  /* Hook must run on every render — keep it above the early return (Rules of Hooks) */
  useEffect(() => {
    if (confirmed || failed) {
      const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }
  }, [confirmed, failed, onClose]);

  if (!state.visible || state.stage === 'idle') return null;

  const activeStepIndex = STEPS.findIndex(s => s.stage === state.stage);

  return (
    <div className={styles.overlay} onClick={failed || confirmed ? onClose : undefined}
      role="dialog" aria-modal="true" aria-label="Transaction status">
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        {confirmed && <div className={styles.successIcon}><CheckCircle2 size={48} /></div>}
        {failed && <div className={styles.failIcon}><XCircle size={48} /></div>}
        {!confirmed && !failed && (
          <div className={styles.spinner}><Loader2 size={48} /></div>
        )}

        <h3 className={styles.title}>
          {confirmed ? 'Success!' : failed ? 'Transaction Failed' : 'Processing Transaction'}
        </h3>

        <div className={styles.steps}>
          {STEPS.map((step, i) => {
            const isActive = i === activeStepIndex && !confirmed && !failed;
            const isPast = i < (confirmed ? STEPS.length : activeStepIndex);
            const isPending = i > activeStepIndex || (failed && i === activeStepIndex);
            return (
              <div key={step.stage} className={`${styles.step} ${isActive ? styles.active : ''} ${isPast ? styles.past : ''} ${isPending ? styles.pending : ''}`}>
                <div className={styles.stepIcon}>
                  {isPast ? <CheckCircle2 size={16} /> : (isActive ? <Loader2 size={16} className={styles.pulse} /> : step.icon)}
                </div>
                <span className={styles.stepLabel}>{step.label}</span>
                {i < STEPS.length - 1 && <ArrowRight size={14} className={styles.arrow} />}
              </div>
            );
          })}
        </div>

        {failed && (
          <div className={styles.errorBox}>
            {state.errorMsg || 'An unexpected error occurred. Please try again.'}
          </div>
        )}

        {(confirmed || failed) && (
          <button onClick={onClose} className={styles.closeBtn}>
            {confirmed ? 'Done' : 'Dismiss'}
          </button>
        )}
      </div>
    </div>
  );
}
