'use client';
import { Button } from '@clutchbox/ui/components/button';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

// Copies `text` and confirms in place for two seconds. `label` names what is copied, for screen readers.
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <Button
      variant="secondary"
      aria-label={label}
      onClick={() =>
        // The clipboard is missing outside secure contexts, so a throw counts as a failure too.
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
            () => setState('copied'),
            () => setState('failed'),
          )
      }
    >
      {state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </Button>
  );
}
