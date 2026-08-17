/**
 * Shared reveal-transition spec (multi-inclusive-plan: SHARED SPEC). Onboarding (A3) and the
 * regular-capture editor reveal (A5) MUST use these same values - the parity gate compares them.
 * Plain constants with no platform or RN imports: identical timing on iOS and Android is a
 * requirement, and nothing here may drift per-platform.
 */

/** The before->after transition itself. Spec allows 400-800ms. */
export const REVEAL_DURATION_MS = 600;

/** How long the finished structured state stays on screen before the flow moves on. */
export const REVEAL_HOLD_MS = 700;
