// No Pro-only feature is gated in this edition anymore. Kept as a no-op component (instead of
// deleting the file) so any residual import stays valid; it renders nothing.
export type ProFeature = never;

export function ProGate(): null {
  return null;
}
