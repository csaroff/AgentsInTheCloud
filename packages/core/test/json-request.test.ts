import { expect, test } from "bun:test";
import { isJsonObject, isNumber, isString } from "../src/json-request.ts";

test("JSON object validation preserves nested extension data without accepting non-JSON values", () => {
  expect(isJsonObject({ text: "λ", count: 42, enabled: true, missing: null, nested: [{ values: [false, 0, ""] }] })).toBe(true);
  expect(isJsonObject({})).toBe(true);
  for (const invalid of [null, [], "text", undefined, { value: undefined }, { value: NaN }, { value: Infinity },
    { nested: [{ callback() {} }] }, { nested: [{ value: 1n }] }]) {
    expect(isJsonObject(invalid)).toBe(false);
  }
});

test("string and number guards accept only their own type", () => {
  expect([isString(""), isString(0), isString(undefined)]).toEqual([true, false, false]);
  expect([isNumber(0), isNumber("0"), isNumber(NaN)]).toEqual([true, false, false]);
});
