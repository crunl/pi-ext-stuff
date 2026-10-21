import { describe, expect, it } from "vitest";
import { createDenialCircuit } from "../src/denial-circuit.ts";

/**
 * The denial circuit is exercised only through recordDenial / recordSuccess /
 * readout / open. That is the whole point of the module: a caller cannot reach
 * the consecutive counter, the window, or the open bit individually, so no test
 * here can encode an arrangement of internals the implementation is free to
 * change.
 */
describe("denial circuit", () => {
  it("starts closed with no denials", () => {
    const circuit = createDenialCircuit();
    expect(circuit.open()).toBe(false);
    expect(circuit.readout()).toEqual({ consecutiveDenials: 0, recentDenials: 0 });
  });

  it("defaults to three consecutive denials and a ten-denial window", () => {
    // The policy the Engine gets when its options set no threshold. Changing
    // either default number has to be a deliberate change here too.
    const consecutive = createDenialCircuit();
    consecutive.recordDenial();
    consecutive.recordDenial();
    expect(consecutive.open()).toBe(false);
    consecutive.recordDenial();
    expect(consecutive.open()).toBe(true);

    const windowed = createDenialCircuit({ maxConsecutiveDenials: 100 });
    for (let index = 0; index < 9; index += 1) windowed.recordDenial();
    expect(windowed.open()).toBe(false);
    windowed.recordDenial();
    expect(windowed.open()).toBe(true);
  });

  it("opens on the third consecutive denial, not before", () => {
    const circuit = createDenialCircuit({ maxConsecutiveDenials: 3, maxWindowDenials: 100 });
    circuit.recordDenial();
    expect(circuit.open()).toBe(false);
    circuit.recordDenial();
    expect(circuit.open()).toBe(false);
    expect(circuit.readout()).toEqual({ consecutiveDenials: 2, recentDenials: 2 });
    circuit.recordDenial();
    expect(circuit.open()).toBe(true);
    expect(circuit.readout()).toEqual({ consecutiveDenials: 3, recentDenials: 3 });
  });

  it("opens on a full denial window even when the denials are not consecutive", () => {
    const circuit = createDenialCircuit({
      maxConsecutiveDenials: 100,
      denialWindowSize: 3,
      maxWindowDenials: 2,
    });
    circuit.recordDenial();
    circuit.recordSuccess();
    expect(circuit.open()).toBe(false);
    circuit.recordDenial();
    // Two denials inside a three-wide window, never two in a row.
    expect(circuit.readout()).toEqual({ consecutiveDenials: 1, recentDenials: 2 });
    expect(circuit.open()).toBe(true);
  });

  it("clears the run and closes the circuit on a success", () => {
    const circuit = createDenialCircuit({ maxConsecutiveDenials: 2, maxWindowDenials: 100 });
    circuit.recordDenial();
    circuit.recordDenial();
    expect(circuit.open()).toBe(true);
    circuit.recordSuccess();
    expect(circuit.open()).toBe(false);
    // The run is gone; the window still remembers the two denials it saw.
    expect(circuit.readout()).toEqual({ consecutiveDenials: 0, recentDenials: 2 });
    // A cleared circuit needs another full run to open again.
    circuit.recordDenial();
    expect(circuit.open()).toBe(false);
  });

  it("bounds the window, so old denials stop counting toward the threshold", () => {
    const circuit = createDenialCircuit({
      maxConsecutiveDenials: 100,
      denialWindowSize: 2,
      maxWindowDenials: 2,
    });
    circuit.recordDenial();
    circuit.recordSuccess();
    circuit.recordSuccess();
    // The first denial has left a two-wide window.
    expect(circuit.readout()).toEqual({ consecutiveDenials: 0, recentDenials: 0 });
    expect(circuit.open()).toBe(false);
  });

  it("publishes a readout the caller cannot use to advance the circuit", () => {
    const circuit = createDenialCircuit({ maxConsecutiveDenials: 1 });
    const readout = circuit.readout();
    expect(readout).toEqual({ consecutiveDenials: 0, recentDenials: 0 });
    // Mutating the published copy leaves the circuit untouched: the counters
    // are only reachable through this module's own transitions.
    (readout as { consecutiveDenials: number }).consecutiveDenials = 99;
    expect(circuit.readout()).toEqual({ consecutiveDenials: 0, recentDenials: 0 });
    expect(circuit.open()).toBe(false);
  });
});
