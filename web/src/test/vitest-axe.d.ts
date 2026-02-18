import type AxeCore from "axe-core";

interface NoViolationsResult {
  pass: boolean;
  message(): string;
  actual: AxeCore.Result[];
}

declare module "@vitest/expect" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): NoViolationsResult;
  }

  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): NoViolationsResult;
  }
}

declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): NoViolationsResult;
  }

  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): NoViolationsResult;
  }
}
