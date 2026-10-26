'use client';
import { Button } from '@agent-computers/ui/components/button';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main" className="mx-auto grid w-full max-w-2xl gap-4 px-5 py-24 sm:px-8">
      <h1 className="font-heading text-5xl leading-[1.04] font-medium tracking-[-0.02em]">Temporarily unavailable.</h1>
      <p className="text-foreground">We couldn’t load your account. Please try again shortly.</p>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
