import { describe, expect, it } from "vitest";
import { setupDestination, type SetupStatus } from "./setupDiscovery.ts";

const ready: SetupStatus = {
  bootstrapRequired: false,
  setupEnabled: true,
  oidcEnabled: false,
  emailEnabled: true,
  requireEmailVerification: true,
};
const required: SetupStatus = { ...ready, bootstrapRequired: true };

describe("setup discovery routing", () => {
  it("waits for discovery instead of prematurely showing login", () => {
    expect(setupDestination("/login", undefined)).toBeNull();
  });
  it("routes login and unauthenticated root visits to setup when bootstrap is required", () => {
    expect(setupDestination("/login", required)).toBe("/setup");
    expect(setupDestination("/", required, true)).toBe("/setup");
  });
  it("routes unauthenticated root visits to login only after setup discovery completes", () => {
    expect(setupDestination("/", ready, true)).toBe("/login");
  });
  it("does not leave an initialized installation on the setup screen", () => {
    expect(setupDestination("/setup", ready)).toBe("/login");
  });
});
