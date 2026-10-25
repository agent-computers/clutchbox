// Sign-in and consent: a plain page with the wordmark, outside the signed-in app's shell.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto w-full max-w-5xl px-5 pt-8 pb-6 sm:px-8">
        <p className="font-serif text-lg font-medium italic">agent computers</p>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
