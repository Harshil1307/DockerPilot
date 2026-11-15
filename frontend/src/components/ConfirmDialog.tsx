import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type PendingConfirmation = ConfirmOptions & { resolve: (accepted: boolean) => void };
type ConfirmContextValue = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    pendingRef.current?.resolve(false);
    const next = { ...options, resolve };
    pendingRef.current = next;
    setPending(next);
  }), []);

  const finish = useCallback((accepted: boolean) => {
    const active = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (dialogRef.current?.open) dialogRef.current.close();
    active?.resolve(accepted);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (pending && dialog && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    }
  }, [pending]);

  return <ConfirmContext.Provider value={confirm}>
    {children}
    <dialog className="dp-confirm-dialog" ref={dialogRef} aria-labelledby="dp-confirm-title" aria-describedby="dp-confirm-message" onCancel={(event) => { event.preventDefault(); finish(false); }}>
      {pending && <>
        <span className={`dp-confirm-mark${pending.destructive ? ' is-danger' : ''}`} aria-hidden="true">{pending.destructive ? '!' : 'i'}</span>
        <h2 id="dp-confirm-title">{pending.title}</h2>
        <p id="dp-confirm-message">{pending.message}</p>
        <div className="dp-confirm-actions">
          <button className="secondary-button" type="button" ref={cancelRef} onClick={() => finish(false)}>{pending.cancelLabel ?? 'Cancel'}</button>
          <button className={pending.destructive ? 'danger-button' : 'primary-button'} type="button" onClick={() => finish(true)}>{pending.confirmLabel ?? 'Continue'}</button>
        </div>
      </>}
    </dialog>
  </ConfirmContext.Provider>;
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside ConfirmProvider.');
  return confirm;
}
