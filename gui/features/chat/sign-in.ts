// Does an answer say Claude Code's sign-in ran out (an expired or refused sign-in, "Please run
// /login")? Then a button on it signs in again (composer.ts signInChip).
export function needsSignIn(text: string): boolean {
  return /failed to authenticate|run \/login|not logged in|oauth (?:token|session)[^.]*expired|invalid api key/i.test(
    text,
  );
}
