import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { roundToDecimals, snapDecimals } from "../src/snap.js";

describe("Klickraster nach Zoomstufe", () => {
  it("rastert im Ausgangsbild auf 0,1 m", () => {
    assert.equal(snapDecimals(10, 10), 1);
    assert.equal(roundToDecimals(1.2345, 1), 1.2);
  });

  it("wird je Zehnerpotenz Annäherung um eine Stelle feiner", () => {
    assert.equal(snapDecimals(1, 10), 2);
    assert.equal(snapDecimals(0.1, 10), 3);
  });

  it("wird beim Herauszoomen gröber, bis auf ganze Meter und darüber", () => {
    assert.equal(snapDecimals(100, 10), 0);
    assert.equal(roundToDecimals(123.4, -1), 120);
  });

  it("liefert keine Gleitkommareste", () => {
    assert.equal(roundToDecimals(0.1 + 0.2, 1), 0.3);
    assert.doesNotMatch(String(roundToDecimals(2.675, 2)), /\d{5,}/);
  });
});
