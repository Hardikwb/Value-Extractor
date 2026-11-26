import { describe, expect, it } from "vitest";
import { isEnglish, isThrottled, isTimedTextUrl, listedLanguages, TRANSLATION_WAITS, withTranslation } from "./youtube.js";

describe("translated captions", () => {
  const TT = "https://www.youtube.com/api/timedtext?v=abc&lang=hi&caps=asr";
  it("adds the translation parameter only to caption downloads", () => {
    expect(isTimedTextUrl(TT)).toBe(true);
    expect(withTranslation(TT)).toBe(TT + "&tlang=en");
    const player = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
    expect(isTimedTextUrl(player)).toBe(false);
    expect(withTranslation(player)).toBe(player); // other requests are left alone
  });
  it("does not add it twice, and supports URLs without a query", () => {
    expect(withTranslation(TT + "&tlang=en")).toBe(TT + "&tlang=en");
    expect(withTranslation("https://www.youtube.com/api/timedtext")).toBe("https://www.youtube.com/api/timedtext?tlang=en");
  });
  it("reads the languages from the library's error message", () => {
    expect(listedLanguages("No transcripts are available in en this video (x). Available languages: hi")).toEqual(["hi"]);
    expect(listedLanguages("... Available languages: ta, hi, en-GB")).toEqual(["ta", "hi", "en-GB"]);
    expect(listedLanguages("something else")).toEqual([]);
  });
  it("recognises English tracks including regional variants", () => {
    for (const l of ["en", "en-US", "en-GB", "en_IN"]) expect(isEnglish(l)).toBe(true);
    for (const l of ["hi", "ta", "enx", "de"]) expect(isEnglish(l)).toBe(false);
  });
});

describe("retrying translated captions", () => {
  it("retries throttling and network errors, but not real answers", () => {
    for (const st of [429, 500, 503, 0]) expect(isThrottled(st)).toBe(true);
    for (const st of [200, 204, 400, 403, 404, -1]) expect(isThrottled(st)).toBe(false);
  });
  it("waits a bit longer each time, within a sensible total", () => {
    for (let i = 1; i < TRANSLATION_WAITS.length; i++) expect(TRANSLATION_WAITS[i]).toBeGreaterThan(TRANSLATION_WAITS[i - 1]);
    expect(TRANSLATION_WAITS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60000);
  });
});
