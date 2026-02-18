import type AxeCore from "axe-core";
import { axe } from "vitest-axe";

/**
 * Default axe rules to disable in jsdom.
 * These fire as false positives because jsdom lacks a full browser environment:
 * - html-has-lang: jsdom doesn't set <html lang="...">
 * - region: components render in isolation without page landmarks
 */
const JSDOM_DISABLED_RULES: AxeCore.RuleObject = {
  "html-has-lang": { enabled: false },
  region: { enabled: false },
};

/**
 * Run axe accessibility checks on the given container.
 * jsdom-specific false-positive rules are disabled by default.
 * Returns the axe results for assertion with toHaveNoViolations().
 */
export async function checkA11y(
  container: HTMLElement = document.body,
  options?: AxeCore.RunOptions,
) {
  return axe(container, {
    ...options,
    rules: { ...JSDOM_DISABLED_RULES, ...options?.rules },
  });
}
